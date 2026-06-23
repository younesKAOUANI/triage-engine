import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { runWithCorrelation } from '../common/correlation/correlation';
import { runInTransaction } from '../common/database/transaction.helper';
import { MetricsService } from '../observability/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { TicketsService } from '../tickets/tickets.service';
import { DlqService } from './dlq/dlq.service';
import { ENRICHER, Enricher, EnrichmentOutcome } from './enricher.port';
import { pipelineBackoffStrategy } from './pipeline.backoff';
import { PIPELINE_QUEUE, PipelineJobData } from './pipeline.constants';

/**
 * The pipeline worker. For one ticket it: loads it, enriches it (via the swappable
 * ENRICHER), then in a SINGLE transaction persists the result AND writes the
 * side-effect row to the outbox — so the state change and the intent to notify
 * commit atomically. BullMQ handles retries with the custom exponential+jitter
 * backoff; a job that exhausts them is dead-lettered by the `failed` handler.
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
  ) {
    super();
  }

  process(job: Job<PipelineJobData>): Promise<void> {
    const data = job.data;
    // Re-establish the correlation scope from the job payload (ALS doesn't cross
    // the Redis boundary), so every log line below — and the outbox payload —
    // carries the same id the original HTTP request did.
    return runWithCorrelation(data.correlationId, async () => {
      this.logger.log(
        { jobId: job.id, ticketId: data.ticketId, attempt: job.attemptsMade + 1 },
        'processing ticket',
      );
      const ticket = await this.tickets.findByIdOrThrow(data.ticketId);
      const outcome = await this.enricher.enrich(ticket);
      await this.persistAndEmit(ticket, outcome, data);
      this.metrics.eventsProcessed.inc();
      this.logger.log(
        {
          jobId: job.id,
          ticketId: ticket.id,
          status: outcome.status,
          source: outcome.source,
        },
        'ticket processed',
      );
    });
  }

  private async persistAndEmit(
    ticket: TicketEntity,
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

      // Side effect written in the SAME transaction as the state change. The
      // stable `version` means a reprocess/replay re-emits the same dedup key and
      // is absorbed — one ticket triage produces exactly one notification.
      await this.outbox.emit(manager, {
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        eventType: 'ticket.triaged',
        version: 'v1',
        payload: {
          ticketId: ticket.id,
          category: outcome.category,
          priority: outcome.priority,
          summary: outcome.summary,
          source: outcome.source,
          correlationId: data.correlationId ?? null,
        },
      });
    });
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
