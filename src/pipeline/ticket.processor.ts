import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import { backoffWithJitter } from '../common/backoff/backoff';
import { runWithCorrelation } from '../common/correlation/correlation';
import { runInTransaction } from '../common/database/transaction.helper';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { MetricsService } from '../observability/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { EnrichmentStatus } from '../tickets/ticket.enums';
import { TicketsService } from '../tickets/tickets.service';
import { DlqService } from './dlq/dlq.service';
import { ENRICHER, Enricher, EnrichmentOutcome } from './enricher.port';
import { pipelineBackoffStrategy } from './pipeline.backoff';
import {
  PIPELINE_QUEUE,
  PipelineJobData,
  SIDE_EFFECT_TRIAGED,
  SIDE_EFFECT_UPGRADED,
} from './pipeline.constants';
import { PipelineProducer } from './pipeline.producer';

/**
 * Upper bound on the `job.isFailed()` terminality probe. Redis may be the thing
 * that is broken, and a disconnected ioredis queues commands instead of failing,
 * so an unbounded probe could hang the failure handler indefinitely.
 */
const TERMINAL_PROBE_TIMEOUT_MS = 2000;

/**
 * The pipeline worker. For one ticket it: loads it, enriches it (via the
 * swappable ENRICHER — now the AI enricher, which degrades to a fallback rather
 * than failing), then in a SINGLE transaction persists the result AND, if a side
 * effect is warranted by the state transition, writes the outbox row.
 *
 * Side effects are keyed off the PRIOR enrichment state so the right event fires
 * exactly once (ADR-0005):
 *   PENDING  -> *           : ticket.triaged          (first triage notification)
 *   DEGRADED -> ENRICHED    : ticket.enrichment_upgraded (a genuine second change)
 *   DEGRADED -> DEGRADED    : nothing new (the triaged event already fired)
 *   ENRICHED -> *           : nothing new (idempotent reprocess/replay)
 *
 * A DEGRADED outcome additionally schedules a delayed AI re-enrichment so the
 * ticket can be upgraded once the model recovers — never dropped because the AI
 * was down.
 */
@Processor(PIPELINE_QUEUE, {
  concurrency: 5,
  settings: { backoffStrategy: pipelineBackoffStrategy },
})
export class TicketProcessor extends WorkerHost {
  private readonly logger = new Logger(TicketProcessor.name);

  constructor(
    private readonly tickets: TicketsService,
    @Inject(ENRICHER) private readonly enricher: Enricher,
    private readonly outbox: OutboxService,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly dlq: DlqService,
    private readonly producer: PipelineProducer,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {
    super();
  }

  process(job: Job<PipelineJobData>): Promise<void> {
    const data = job.data;
    // Re-establish the correlation scope from the job payload (ALS doesn't cross
    // the Redis boundary), so every log line below — and the outbox payload —
    // carries the same id the original HTTP request did.
    return runWithCorrelation(data.correlationId, async () => {
      const ticket = await this.tickets.findByIdOrThrow(data.ticketId);
      const prior = ticket.enrichmentStatus;
      this.logger.log(
        {
          jobId: job.id,
          ticketId: data.ticketId,
          prior,
          upgradeAttempt: data.upgradeAttempt,
          attempt: job.attemptsMade + 1,
        },
        'processing ticket',
      );

      const outcome = await this.enricher.enrich(ticket);
      await this.persistAndEmit(ticket, prior, outcome, data);

      // Degraded now → try to upgrade to an AI result later (delayed, jittered).
      if (outcome.status === EnrichmentStatus.DEGRADED) {
        await this.scheduleUpgrade(data);
      }

      this.metrics.eventsProcessed.inc();
      this.logger.log(
        { jobId: job.id, ticketId: ticket.id, status: outcome.status, source: outcome.source },
        'ticket processed',
      );
    });
  }

  private async persistAndEmit(
    ticket: TicketEntity,
    prior: EnrichmentStatus,
    outcome: EnrichmentOutcome,
    data: PipelineJobData,
  ): Promise<void> {
    await runInTransaction(this.dataSource, async (manager) => {
      await manager
        .createQueryBuilder()
        .update(TicketEntity)
        .set({
          enrichmentStatus: outcome.status,
          enrichmentSource: outcome.source,
          category: outcome.category,
          priority: outcome.priority,
          summary: outcome.summary,
          confidence: outcome.confidence,
          enrichedAt: () => 'now()',
          enrichmentAttempts: () => '"enrichment_attempts" + 1',
        })
        .where('id = :id', { id: ticket.id })
        .execute();

      // Emit the side effect warranted by the state transition (same transaction
      // as the update). Stable `version` so a reprocess/replay re-emits the same
      // dedup key and is absorbed — one transition produces one notification.
      const payload = {
        ticketId: ticket.id,
        category: outcome.category,
        priority: outcome.priority,
        summary: outcome.summary,
        source: outcome.source,
        correlationId: data.correlationId ?? null,
      };

      if (prior === EnrichmentStatus.PENDING) {
        await this.outbox.emit(manager, {
          aggregateType: 'ticket',
          aggregateId: ticket.id,
          eventType: SIDE_EFFECT_TRIAGED,
          version: 'v1',
          payload,
        });
      } else if (
        prior === EnrichmentStatus.DEGRADED &&
        outcome.status === EnrichmentStatus.ENRICHED
      ) {
        await this.outbox.emit(manager, {
          aggregateType: 'ticket',
          aggregateId: ticket.id,
          eventType: SIDE_EFFECT_UPGRADED,
          version: 'v1',
          payload,
        });
      }
    });
  }

  private async scheduleUpgrade(data: PipelineJobData): Promise<void> {
    const attempt = (data.upgradeAttempt ?? 0) + 1;
    if (attempt > this.env.ENRICHMENT_UPGRADE_MAX_ATTEMPTS) {
      this.logger.warn(
        { ticketId: data.ticketId, attempt },
        'AI upgrade attempts exhausted; ticket remains DEGRADED with fallback result',
      );
      return;
    }
    const delay = backoffWithJitter(attempt, {
      baseMs: this.env.ENRICHMENT_UPGRADE_BACKOFF_MS,
    });
    await this.producer.enqueueUpgrade({ ...data, upgradeAttempt: attempt }, delay);
    this.logger.log(
      { ticketId: data.ticketId, attempt, delayMs: delay },
      'scheduled delayed AI re-enrichment (upgrade)',
    );
  }

  /**
   * Fires on every failed attempt. We dead-letter only when the failure is
   * TERMINAL — i.e. the job will never run again — and otherwise just count a
   * retry. (BullMQ has already scheduled the next attempt by the time this runs.)
   *
   * NOTHING may escape this method: @nestjs/bullmq subscribes with a bare
   * `worker.on(...)`, so a rejected promise here is an *unhandled* rejection —
   * it would lose the dead letter and can tear the worker down.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<PipelineJobData>, error: Error): Promise<void> {
    try {
      if (!(await this.classifyFailure(job, error))) {
        this.metrics.eventsFailed.inc({ disposition: 'retry' });
        this.logger.warn(
          { jobId: job.id, attempt: job.attemptsMade, err: error?.message },
          'pipeline attempt failed; will retry',
        );
        return;
      }

      // Classification and persistence are caught SEPARATELY and deliberately:
      // only a failure here means the durable record is actually missing, so
      // only here may we raise the alarm that says a job was lost.
      try {
        await this.dlq.recordDeadLetter(job, error);
      } catch (persistError) {
        // Postgres unreachable. This log line is now the last remaining trace of
        // the job, so emit the whole payload to make it reconstructable.
        this.metrics.eventsFailed.inc({
          disposition: 'dead_letter_write_failed',
        });
        this.logger.error(
          {
            jobId: job.id,
            idempotencyKey: job.data?.idempotencyKey,
            ticketId: job.data?.ticketId,
            payload: job.data,
            originalError: error?.message,
            err: persistError,
          },
          'could not persist dead letter; job is unrecoverable from the queue — replay it from this log line',
        );
      }
    } catch (unexpected) {
      // Absolute backstop. @nestjs/bullmq subscribes with a bare `worker.on()`,
      // so a rejection escaping this method is an unhandled rejection.
      this.logger.error(
        { jobId: job?.id, err: unexpected },
        'ticket failure handler threw unexpectedly',
      );
    }
  }

  /**
   * Decide terminality, and never propagate a failure of the *decision* itself.
   *
   * If we cannot tell (the `isFailed()` probe needs Redis, which may be exactly
   * what is broken), we fail SAFE by assuming terminal. The asymmetry is
   * deliberate: a spurious dead letter is harmless and self-correcting — an
   * operator replays it, and the replay re-enters through the original
   * idempotency key, so it can duplicate neither the ticket nor the side effect.
   * A *missed* dead letter is exactly the silent loss this engine exists to
   * prevent.
   */
  private async classifyFailure(
    job: Job<PipelineJobData>,
    error: Error,
  ): Promise<boolean> {
    try {
      return await this.isTerminalFailure(job, error);
    } catch (classifyError) {
      this.logger.warn(
        { jobId: job.id, err: classifyError },
        'could not determine whether failure was terminal; assuming terminal so the job is recorded rather than lost',
      );
      return true;
    }
  }

  /**
   * Is this failure the job's last? `attemptsMade >= opts.attempts` alone is NOT
   * a sufficient test, because BullMQ has terminal paths that never increment
   * `attemptsMade`:
   *
   *  - **Stalled jobs.** When a worker dies or loses its lock, the recovery
   *    script bumps the *stall* counter (`stc`), not the attempt counter (`atm`),
   *    and once it passes `maxStalledCount` it writes a deferred-failure marker
   *    (`defa`) onto the job hash. On the next pickup the worker turns that
   *    marker into an `UnrecoverableError` *before* the processor ever runs, and
   *    `Job.shouldRetryJob` declines to retry it — the job is in the failed set
   *    for good, typically with `attemptsMade` of 1 against `attempts` of 5.
   *  - **`maxStartedAttempts`**, and an `UnrecoverableError` thrown by the
   *    processor, fail the same way.
   *  - **`job.discard()`** and a backoff strategy returning -1 also stop retries.
   *
   * Read naively, every one of those looks like "an attempt failed, more remain",
   * so the job would be dropped without a dead_letters row — exactly the silent
   * loss this engine exists to prevent (ADR-0007). The ticket would also stay
   * PENDING, which the DEGRADED reconciliation sweep does not scan for.
   */
  private async isTerminalFailure(
    job: Job<PipelineJobData>,
    error: Error,
  ): Promise<boolean> {
    // Name check as well as instanceof: the error may have been constructed in a
    // different module realm (duplicate bullmq copy), which defeats instanceof.
    if (
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError'
    ) {
      return true;
    }
    // Normal exhaustion. `moveToFailed` increments attemptsMade *before* emitting
    // 'failed', so on the final attempt this is already == opts.attempts.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      return true;
    }
    // Backstop for every other terminal path (discard(), backoff -1, whatever
    // BullMQ adds next): if the job is sitting in the failed set, it is done.
    //
    // Two constraints this depends on:
    //  - It reads the failed set, so `removeOnFail` must RETAIN the job long
    //    enough to be observed. `true`, `{ age: 0 }` and `{ count: 0 }` all
    //    delete it first and silently defeat the backstop.
    //  - It needs Redis, which may be the very thing that is broken, and a
    //    disconnected ioredis queues commands rather than failing fast. Bound it
    //    so the handler can never hang; the caller treats a rejection as
    //    "assume terminal".
    return this.withTimeout(
      job.isFailed(),
      TERMINAL_PROBE_TIMEOUT_MS,
      'isFailed() probe timed out',
    );
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() =>
      clearTimeout(timer),
    ) as Promise<T>;
  }
}
