import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { PipelineProducer } from './pipeline.producer';

interface StrandedRow {
  ticket_id: string;
  event_id: string;
  idempotency_key: string;
}

/**
 * Reconciliation sweep (ADR-0009). Treats Postgres as the source of truth and
 * re-drives tickets stuck in DEGRADED — the one path that could otherwise leave a
 * ticket silently un-upgraded if its delayed upgrade job was lost (Redis flush,
 * crash before enqueue, or exhausted attempts).
 *
 * It scans for DEGRADED tickets that haven't changed in a while and re-enqueues
 * them through their original idempotency key, restarting the upgrade chain.
 * Bounded by interval + batch size + a per-ticket jobId, so a post-outage backlog
 * drains steadily instead of stampeding the recovering AI.
 */
@Injectable()
export class ReconcileSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileSweeper.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly producer: PipelineProducer,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.sweep(),
      this.env.RECONCILE_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * One sweep pass. Public so it can be invoked deterministically in tests; the
   * timer just calls it on a schedule. Returns the number of tickets re-driven.
   */
  async sweep(): Promise<number> {
    if (this.stopped || this.running) {
      return 0;
    }
    this.running = true;
    try {
      const stranded: StrandedRow[] = await this.dataSource.query(
        `SELECT t.id AS ticket_id, t.event_id, e.idempotency_key
           FROM tickets t
           JOIN events e ON e.id = t.event_id
          WHERE t.enrichment_status = 'DEGRADED'
            AND t.updated_at < now() - (interval '1 millisecond' * $1)
          ORDER BY t.updated_at ASC
          LIMIT $2`,
        [this.env.RECONCILE_DEGRADED_AFTER_MS, this.env.RECONCILE_BATCH_SIZE],
      );

      // Count only tickets actually re-driven. A suppressed add (one already in
      // flight) is fine, but counting it would make the sweep report a recovery
      // it did not perform — and this sweep is the last line of defence, so it
      // must not overstate what it did.
      //
      // One failing row must not abort the batch either: every other stranded
      // ticket in this pass would be skipped, and the log would still claim
      // success for the ones that came before it.
      let redriven = 0;
      let failed = 0;
      for (const row of stranded) {
        try {
          const enqueued = await this.producer.enqueueReconcile({
            idempotencyKey: row.idempotency_key,
            ticketId: row.ticket_id,
            eventId: row.event_id,
          });
          if (enqueued) {
            redriven++;
          }
        } catch (error) {
          failed++;
          this.logger.error(
            { err: error, ticketId: row.ticket_id },
            'failed to re-drive stranded ticket; continuing with the batch',
          );
        }
      }

      if (redriven > 0 || failed > 0) {
        this.logger.warn(
          { scanned: stranded.length, redriven, failed },
          're-drove tickets stranded in DEGRADED',
        );
      }
      return redriven;
    } catch (error) {
      this.logger.error({ err: error }, 'reconciliation sweep failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}
