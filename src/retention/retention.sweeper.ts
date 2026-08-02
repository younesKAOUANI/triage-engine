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
import { MetricsService } from '../observability/metrics.service';

/**
 * Deletes data past its retention window.
 *
 * Two reasons this exists. The demo runs unattended on a public URL that anyone
 * can POST to, so something has to bound the disk. And `idempotency_keys` grows
 * without limit by design: a key has to outlive the client's retry window, but
 * keeping it forever is only ever a storage decision, never a correctness one
 * (ADR-0001 called this out as unbuilt).
 *
 * Deletion order matters and is the inverse of the FK direction
 * (`events <- tickets <- idempotency_keys`). Children go first, so a row is
 * never orphaned mid-sweep and `ON DELETE RESTRICT` on tickets.event_id never
 * fires. Everything runs in one transaction: a partial prune that removed
 * tickets but not their events would leave the sweep's own join broken.
 *
 * Only terminal rows are eligible. A ticket still PENDING or DEGRADED, or an
 * outbox row still awaiting dispatch, is live work regardless of age, and
 * deleting it would be exactly the silent loss the rest of the engine prevents.
 */
@Injectable()
export class RetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionSweeper.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  onModuleInit(): void {
    if (!this.env.RETENTION_ENABLED) {
      this.logger.log('retention disabled; no data will be pruned');
      return;
    }
    this.timer = setInterval(
      () => void this.sweep(),
      this.env.RETENTION_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** One prune pass. Public so it can be driven deterministically in tests. */
  async sweep(): Promise<Record<string, number>> {
    if (this.stopped || this.running) {
      return {};
    }
    this.running = true;
    const ageMs = this.env.RETENTION_MAX_AGE_MS;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const cutoff = `now() - (interval '1 millisecond' * ${Number(ageMs)})`;

        // Delivered or permanently abandoned notifications. Nothing else refers
        // to these, so they can go first and independently.
        const outbox = await manager.query(
          `DELETE FROM outbox_messages
            WHERE status IN ('SENT','FAILED') AND created_at < ${cutoff}`,
        );

        // Replayed dead letters only. A PENDING one is an unresolved failure
        // somebody may still act on, at any age.
        const deadLetters = await manager.query(
          `DELETE FROM dead_letters
            WHERE status = 'REPLAYED' AND created_at < ${cutoff}`,
        );

        // Settled keys. FAILED rows stay: they are the record of an ingestion
        // that never completed, and are re-drivable.
        const keys = await manager.query(
          `DELETE FROM idempotency_keys
            WHERE status = 'COMPLETED' AND created_at < ${cutoff}`,
        );

        // Tickets that reached a terminal enrichment state, and only once no
        // idempotency row still points at them (that FK is ON DELETE SET NULL,
        // so a surviving key would silently lose its ticket reference).
        const tickets = await manager.query(
          `DELETE FROM tickets t
            WHERE t.enrichment_status IN ('ENRICHED','FAILED')
              AND t.updated_at < ${cutoff}
              AND NOT EXISTS (
                SELECT 1 FROM idempotency_keys k WHERE k.ticket_id = t.id)`,
        );

        // Finally the events, now that no ticket can reference them.
        const events = await manager.query(
          `DELETE FROM events e
            WHERE e.received_at < ${cutoff}
              AND NOT EXISTS (
                SELECT 1 FROM tickets t WHERE t.event_id = e.id)`,
        );

        const pruned = {
          outbox_messages: rowCount(outbox),
          dead_letters: rowCount(deadLetters),
          idempotency_keys: rowCount(keys),
          tickets: rowCount(tickets),
          events: rowCount(events),
        };

        const total = Object.values(pruned).reduce((a, b) => a + b, 0);
        if (total > 0) {
          for (const [table, count] of Object.entries(pruned)) {
            this.metrics.retentionPruned.inc({ table }, count);
          }
          this.logger.log({ ...pruned, ageMs }, 'pruned expired rows');
        }
        return pruned;
      });
    } catch (error) {
      this.logger.error({ err: error }, 'retention sweep failed');
      return {};
    } finally {
      this.running = false;
    }
  }
}

/**
 * A bare DELETE through TypeORM's raw `query()` yields `[rows, affectedCount]`;
 * the same trap as UPDATE ... RETURNING (see ADR-0001). Read the count, never
 * the array length.
 */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
