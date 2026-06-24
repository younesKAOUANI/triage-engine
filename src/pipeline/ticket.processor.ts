import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
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
   * Fires on every failed attempt. We only dead-letter once retries are truly
   * exhausted; earlier failures just count a retry. (BullMQ has already scheduled
   * the next attempt by the time this runs.)
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<PipelineJobData>, error: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.dlq.recordDeadLetter(job, error);
    } else {
      this.metrics.eventsFailed.inc({ disposition: 'retry' });
      this.logger.warn(
        { jobId: job.id, attempt: job.attemptsMade, err: error.message },
        'pipeline attempt failed; will retry',
      );
    }
  }
}
