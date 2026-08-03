import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { backoffWithJitter } from '../common/backoff/backoff';
import { runWithCorrelation } from '../common/correlation/correlation';
import { runInTransaction } from '../common/database/transaction.helper';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { MetricsService } from '../observability/metrics.service';
import {
  OUTBOX_DISPATCHER,
  OutboxDispatcher,
} from './dispatchers/outbox-dispatcher.port';
import { OutboxStatus } from './entities/outbox-message.entity';

/** Raw row shape returned by the polling query (snake_case from Postgres). */
interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  dedup_key: string;
}

/**
 * Polls the outbox and dispatches pending side effects (ADR-0004 / ADR-0008).
 *
 * The poll is the heart of the relay:
 *
 *   SELECT ... WHERE status='PENDING' AND next_attempt_at <= now()
 *   ORDER BY next_attempt_at
 *   FOR UPDATE SKIP LOCKED
 *   LIMIT :batch
 *
 * FOR UPDATE locks the claimed rows; SKIP LOCKED makes a second relay instance
 * step over rows already claimed by the first instead of blocking on them. That
 * single clause is what lets the relay scale horizontally with no coordination
 * and no double-dispatch from contention.
 *
 * Delivery is at-least-once by construction: dispatch happens inside the same
 * transaction that marks the row SENT, so if the process dies after the HTTP call
 * but before commit, the transaction rolls back, the row stays PENDING, and it is
 * redelivered later. The consumer deduplicates on dedup_key. (Trade-off: the row
 * lock is held across the HTTP call. Fine for a single relay; ADR-0008 notes the
 * claim-then-dispatch variant you'd use at high throughput.)
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** Guards against overlapping ticks if a drain runs longer than the interval. */
  private draining = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(OUTBOX_DISPATCHER) private readonly dispatcher: OutboxDispatcher,
    private readonly metrics: MetricsService,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  onModuleInit(): void {
    this.scheduleNext(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.draining) {
      return;
    }
    this.draining = true;
    let processed = 0;
    try {
      processed = await this.drainOnce();
      await this.refreshPendingGauge();
    } catch (error) {
      this.logger.error(
        { err: error },
        'outbox relay tick failed; will retry next interval',
      );
    } finally {
      this.draining = false;
      // If we filled a whole batch there is probably more waiting — drain again
      // immediately. Otherwise wait the poll interval.
      const full = processed >= this.env.OUTBOX_RELAY_BATCH_SIZE;
      this.scheduleNext(full ? 0 : this.env.OUTBOX_RELAY_POLL_INTERVAL_MS);
    }
  }

  /** Claim and dispatch one batch. Returns how many rows were claimed. */
  async drainOnce(): Promise<number> {
    return runInTransaction(this.dataSource, async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts, dedup_key
           FROM outbox_messages
          WHERE status = 'PENDING' AND next_attempt_at <= now()
          ORDER BY next_attempt_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [this.env.OUTBOX_RELAY_BATCH_SIZE],
      );

      for (const row of rows) {
        await this.dispatchRow(manager, row);
      }
      return rows.length;
    });
  }

  private async dispatchRow(
    manager: EntityManager,
    row: OutboxRow,
  ): Promise<void> {
    const correlationId =
      typeof row.payload?.correlationId === 'string'
        ? row.payload.correlationId
        : undefined;
    const stopTimer = this.metrics.outboxDispatchLatency.startTimer();

    try {
      await runWithCorrelation(correlationId, () =>
        this.dispatcher.dispatch({
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          dedupKey: row.dedup_key,
        }),
      );
      stopTimer();

      await manager.query(
        `UPDATE outbox_messages
            SET status = 'SENT', dispatched_at = now(), last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
      this.metrics.outboxDispatched.inc();
    } catch (error) {
      stopTimer();
      await this.handleDispatchFailure(manager, row, error as Error);
    }
  }

  private async handleDispatchFailure(
    manager: EntityManager,
    row: OutboxRow,
    error: Error,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const message = error.message.slice(0, 1000);

    if (attempts >= this.env.OUTBOX_MAX_ATTEMPTS) {
      // Terminal. The partial index excludes FAILED, so this row is no longer
      // polled. This is the metric to alert on: a side effect we gave up on.
      await manager.query(
        `UPDATE outbox_messages
            SET status = $2, attempts = $3, last_error = $4
          WHERE id = $1`,
        [row.id, OutboxStatus.FAILED, attempts, message],
      );
      this.metrics.outboxFailed.inc();
      this.logger.error(
        { outboxId: row.id, eventType: row.event_type, attempts },
        'outbox message exhausted attempts; marked FAILED (side effect abandoned)',
      );
      return;
    }

    const delay = backoffWithJitter(attempts, {
      baseMs: this.env.OUTBOX_BACKOFF_BASE_MS,
    });
    await manager.query(
      `UPDATE outbox_messages
          SET attempts = $2, last_error = $3,
              next_attempt_at = now() + (interval '1 millisecond' * $4)
        WHERE id = $1`,
      [row.id, attempts, message, delay],
    );
    this.logger.warn(
      { outboxId: row.id, attempts, retryInMs: delay, err: message },
      'outbox dispatch failed; rescheduled',
    );
  }

  private async refreshPendingGauge(): Promise<void> {
    const result: Array<{ count: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM outbox_messages WHERE status = 'PENDING'`,
    );
    this.metrics.outboxPending.set(Number(result[0]?.count ?? 0));
  }
}
