import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import {
  ENRICH_TICKET_JOB,
  PIPELINE_QUEUE,
  PipelineJobData,
} from './pipeline.constants';

/**
 * Enqueues pipeline jobs. Two enqueue modes, deliberately different on jobId:
 *
 *  - enqueue():  jobId = idempotency key. BullMQ ignores a duplicate add for an
 *    existing jobId, so re-driving ingestion for the same key cannot create a
 *    second pipeline run. Idempotent by construction.
 *
 *  - enqueueReplay(): jobId = "<key>:replay:<deadLetterId>" — a fresh id so the
 *    job actually re-runs (a duplicate of the original key would be suppressed).
 *    Correctness still holds because the *work* keys off data.idempotencyKey: the
 *    ticket already exists and the outbox dedups, so a replay neither duplicates
 *    the ticket nor the side effect.
 */
@Injectable()
export class PipelineProducer implements OnModuleInit {
  private readonly logger = new Logger(PipelineProducer.name);

  constructor(
    @InjectQueue(PIPELINE_QUEUE) private readonly queue: Queue<PipelineJobData>,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  onModuleInit(): void {
    // An EventEmitter with no 'error' listener rethrows, which on a Queue means
    // a Redis connection blip can take the process down. Log it instead: the
    // queue reconnects on its own, and ingestion should surface the problem
    // rather than die from it.
    this.queue.on('error', (error) => {
      this.logger.error({ err: error }, 'pipeline queue error');
    });
  }

  async enqueue(data: PipelineJobData): Promise<string> {
    const job = await this.queue.add(ENRICH_TICKET_JOB, data, {
      jobId: data.idempotencyKey,
      attempts: this.env.PIPELINE_MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 3600, count: 1000 },
      // Keep failed jobs briefly for inspection; the durable record is the PG DLQ.
      removeOnFail: { age: 86400 },
    });
    return String(job.id);
  }

  async enqueueReplay(
    data: PipelineJobData,
    deadLetterId: string,
  ): Promise<string> {
    const job = await this.queue.add(
      ENRICH_TICKET_JOB,
      { ...data, replayOfDeadLetterId: deadLetterId },
      {
        jobId: `${data.idempotencyKey}:replay:${deadLetterId}`,
        attempts: this.env.PIPELINE_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    );
    return String(job.id);
  }

  /**
   * Schedule a delayed re-enrichment to upgrade a DEGRADED ticket once the AI may
   * have recovered. The delay (with jitter, computed by the caller) is what
   * decouples recovery from breaker state and avoids a thundering herd: each
   * degraded ticket retries on its own staggered schedule. The jobId includes the
   * attempt number so successive upgrade attempts each actually run.
   */
  async enqueueUpgrade(
    data: PipelineJobData,
    delayMs: number,
  ): Promise<string> {
    const job = await this.queue.add(ENRICH_TICKET_JOB, data, {
      jobId: `${data.idempotencyKey}:upgrade:${data.upgradeAttempt ?? 1}`,
      delay: delayMs,
      attempts: this.env.PIPELINE_MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    });
    return String(job.id);
  }

  /**
   * Re-drive a ticket stranded in DEGRADED (ADR-0009). The per-ticket jobId
   * collapses overlapping sweeps to one in-flight reconcile per ticket. The job
   * restarts the normal upgrade chain (no upgradeAttempt set).
   *
   * Returns false when BullMQ suppressed the add because a job with this id
   * still exists. That is not a failure — it means a reconcile for this ticket
   * is already in flight or recently finished — but the caller must not count it
   * as work done, or the sweep reports a recovery it did not perform.
   *
   * Both retention windows are tied to the sweep interval rather than fixed.
   * Previously `removeOnFail` was 24h, so a reconcile that dead-lettered kept
   * its id alive for a day and silently swallowed every subsequent attempt to
   * re-drive that ticket — disabling the backstop for exactly the tickets that
   * needed it most.
   */
  async enqueueReconcile(data: PipelineJobData): Promise<boolean> {
    const jobId = `${data.idempotencyKey}:reconcile:0`;
    // A terminal job still occupying this id would make the add a no-op. The
    // durable record of that failure is the dead_letters row, not the Redis job,
    // so removing it here loses nothing.
    const existing = await this.queue.getJob(jobId);
    if (existing && (await existing.isFailed())) {
      await existing.remove();
    }

    const job = await this.queue.add(ENRICH_TICKET_JOB, data, {
      // 3 colon-separated parts: BullMQ only permits ':' in a custom jobId when it
      // splits into exactly 3 (legacy repeatable-job compatibility).
      jobId,
      attempts: this.env.PIPELINE_MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      // Short enough that the next sweep can always re-drive a ticket that is
      // still degraded, whatever the interval is tuned to.
      removeOnComplete: { age: this.reconcileJobTtlSeconds() },
      removeOnFail: { age: this.reconcileJobTtlSeconds() },
    });
    // BullMQ returns the pre-existing job on a suppressed add, so a job whose
    // timestamp predates this call was not enqueued by us.
    return job.id === jobId && !existing;
  }

  /**
   * Keep a finished reconcile job around for less than one sweep interval, so a
   * still-degraded ticket is always eligible again by the next pass.
   */
  private reconcileJobTtlSeconds(): number {
    return Math.max(
      5,
      Math.floor(this.env.RECONCILE_SWEEP_INTERVAL_MS / 1000 / 2),
    );
  }

  /** Job counts by state, for the queue-depth gauge. */
  getJobCounts() {
    return this.queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
  }
}
