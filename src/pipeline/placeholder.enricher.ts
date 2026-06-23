import { Injectable } from '@nestjs/common';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import {
  EnrichmentSource,
  EnrichmentStatus,
  TicketCategory,
  TicketPriority,
} from '../tickets/ticket.enums';
import { Enricher, EnrichmentOutcome } from './enricher.port';

/**
 * TEMPORARY core-engine enricher. It produces a deterministic, dependency-free
 * result so the pipeline, outbox, and DLQ can be exercised and reviewed before
 * any AI is wired in. The AI layer replaces this provider (ENRICHER) with the
 * Mistral-backed enricher; nothing else in the pipeline changes.
 */
@Injectable()
export class PlaceholderEnricher implements Enricher {
  async enrich(ticket: TicketEntity): Promise<EnrichmentOutcome> {
    return {
      status: EnrichmentStatus.ENRICHED,
      source: EnrichmentSource.FALLBACK,
      category: TicketCategory.OTHER,
      priority: TicketPriority.MEDIUM,
      summary: ticket.subject.slice(0, 120),
      confidence: 0,
    };
  }
}
