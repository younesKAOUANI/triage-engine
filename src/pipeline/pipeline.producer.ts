import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
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
export class PipelineProducer {
  constructor(
    @InjectQueue(PIPELINE_QUEUE) private readonly queue: Queue<PipelineJobData>,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

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
  async enqueueUpgrade(data: PipelineJobData, delayMs: number): Promise<string> {
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
   * collapses overlapping sweeps to one in-flight reconcile per ticket; a short
   * removeOnComplete lets a later sweep re-drive it if it's still degraded. The
   * job restarts the normal upgrade chain (no upgradeAttempt set).
   */
  async enqueueReconcile(data: PipelineJobData): Promise<string> {
    const job = await this.queue.add(ENRICH_TICKET_JOB, data, {
      // 3 colon-separated parts: BullMQ only permits ':' in a custom jobId when it
      // splits into exactly 3 (legacy repeatable-job compatibility).
      jobId: `${data.idempotencyKey}:reconcile:0`,
      attempts: this.env.PIPELINE_MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 30 },
      removeOnFail: { age: 86400 },
    });
    return String(job.id);
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
