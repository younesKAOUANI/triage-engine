import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getCorrelationId } from '../common/correlation/correlation';
import { hashPayload } from '../common/hash/canonical-hash';
import { runInTransaction } from '../common/database/transaction.helper';
import { EventEntity } from './entities/event.entity';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MetricsService } from '../observability/metrics.service';
import { PipelineProducer } from '../pipeline/pipeline.producer';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { EnrichmentStatus } from '../tickets/ticket.enums';
import { CreateEventDto } from './dto/create-event.dto';

/**
 * The idempotency key becomes a BullMQ job id, and BullMQ constrains those:
 * a custom id may not look like an integer, and may contain ':' only when it
 * splits into exactly three parts. Since the pipeline derives ids by appending
 * suffixes (`<key>:replay:<id>`, `<key>:upgrade:<n>`, `<key>:reconcile:0`), a key
 * containing ':' breaks every one of those schemes.
 *
 * Rejecting such a key at the door — with a 400, before anything is written — is
 * the only place this can be handled cleanly. Downstream it would surface as a
 * committed ticket whose job could never be enqueued.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/;

function assertUsableAsJobId(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new BadRequestException(
      'idempotencyKey must be 1-255 characters of letters, digits, dot, underscore, tilde or hyphen (no colons)',
    );
  }
  if (/^\d+$/.test(key)) {
    throw new BadRequestException(
      'idempotencyKey must not consist only of digits',
    );
  }
}

export interface IngestResult {
  status: 'accepted' | 'processing' | 'replayed';
  idempotencyKey: string;
  ticketId: string | null;
  jobId?: string;
}

/**
 * Ingestion orchestrator. The flow is: derive the key + content hash, try to
 * claim the key, then act on the four possible outcomes. All the hard
 * concurrency guarantees live in IdempotencyService; this class wires them to the
 * actual work of creating a ticket and enqueuing the pipeline.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly pipeline: PipelineProducer,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(
    dto: CreateEventDto,
    headerKey: string | undefined,
  ): Promise<IngestResult> {
    // Hash only the semantic content (NOT the idempotency key itself), so the
    // hash identifies the payload. This is what lets us catch "same key, new body".
    const requestHash = hashPayload({
      subject: dto.subject,
      body: dto.body,
      requesterEmail: dto.requesterEmail ?? null,
      source: dto.source ?? null,
      metadata: dto.metadata ?? null,
    });
    const key = headerKey ?? dto.idempotencyKey ?? requestHash;
    // Validate here rather than on the DTO: the key can also arrive as a header,
    // which no DTO pipe ever sees.
    assertUsableAsJobId(key);
    const correlationId = getCorrelationId();

    const claim = await this.idempotency.claim(key, requestHash);

    switch (claim.outcome) {
      case 'CONFLICT':
        this.metrics.eventsIngested.inc({ result: 'conflict' });
        throw new ConflictException(
          `idempotency key was already used with a different payload`,
        );

      case 'REPLAY': {
        this.metrics.eventsIngested.inc({ result: 'duplicate' });
        const body = (claim.record.responseBody ?? {}) as Partial<IngestResult>;
        this.logger.log({ idempotencyKey: key }, 'idempotent replay');
        return {
          status: 'replayed',
          idempotencyKey: key,
          ticketId: claim.record.ticketId ?? body.ticketId ?? null,
          jobId: body.jobId,
        };
      }

      case 'IN_FLIGHT':
        this.metrics.eventsIngested.inc({ result: 'duplicate' });
        this.logger.log({ idempotencyKey: key }, 'duplicate while in flight');
        return {
          status: 'processing',
          idempotencyKey: key,
          ticketId: claim.record.ticketId ?? null,
        };

      case 'NEW':
        return this.processNew(key, dto, correlationId);
    }
  }

  private async processNew(
    key: string,
    dto: CreateEventDto,
    correlationId: string | undefined,
  ): Promise<IngestResult> {
    let ticketId: string;
    let eventId: string;
    let jobId: string;
    try {
      ({ ticketId, eventId } = await this.createTicketIfAbsent(key, dto));
      // The enqueue is inside the try on purpose. It runs after the ticket has
      // already been committed, so if it throws, the key must not be left
      // PENDING — it would hold its lease for the full reclaim window while no
      // job exists, and nothing would re-drive it.
      jobId = await this.pipeline.enqueue({
        idempotencyKey: key,
        ticketId,
        eventId,
        correlationId,
      });
    } catch (error) {
      // Ingestion failed before completion: mark FAILED so a later request (or a
      // lease-reclaim) is allowed to re-drive this key cleanly.
      await this.idempotency.markFailed(key);
      throw error;
    }

    const responseBody = {
      status: 'accepted' as const,
      idempotencyKey: key,
      ticketId,
      jobId,
    };
    // Mark COMPLETED only after the ticket exists AND the job is enqueued, so a
    // replay always returns a result that is fully wired up.
    await this.idempotency.markCompleted(key, ticketId, 202, responseBody);
    this.metrics.eventsIngested.inc({ result: 'accepted' });
    this.logger.log({ idempotencyKey: key, ticketId, jobId }, 'event accepted');
    return responseBody;
  }

  /**
   * Create the event + ticket exactly once for this key. The idempotency row is
   * locked FOR UPDATE first, so if a crash-and-reclaim causes this to run twice,
   * the second run sees the already-attached ticket and reuses it instead of
   * creating a duplicate.
   */
  private async createTicketIfAbsent(
    key: string,
    dto: CreateEventDto,
  ): Promise<{ ticketId: string; eventId: string }> {
    return runInTransaction(this.dataSource, async (manager) => {
      const idem = await this.idempotency.lockForUpdate(manager, key);
      if (idem.ticketId) {
        const existing = await manager.findOneByOrFail(TicketEntity, {
          id: idem.ticketId,
        });
        return { ticketId: existing.id, eventId: existing.eventId };
      }

      const event = manager.create(EventEntity, {
        idempotencyKey: key,
        payload: dto as unknown as Record<string, unknown>,
        source: dto.source ?? null,
      });
      await manager.save(event);

      const ticket = manager.create(TicketEntity, {
        eventId: event.id,
        subject: dto.subject,
        body: dto.body,
        requesterEmail: dto.requesterEmail ?? null,
        enrichmentStatus: EnrichmentStatus.PENDING,
      });
      await manager.save(ticket);

      await this.idempotency.attachTicket(manager, key, ticket.id);
      return { ticketId: ticket.id, eventId: event.id };
    });
  }
}
