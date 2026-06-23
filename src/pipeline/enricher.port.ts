import { TicketEntity } from '../tickets/entities/ticket.entity';
import {
  EnrichmentSource,
  EnrichmentStatus,
  TicketCategory,
  TicketPriority,
} from '../tickets/ticket.enums';

/**
 * The result of classifying a ticket. Identical shape whether produced by the AI
 * or the rule-based fallback — that interchangeability is the whole point of the
 * degradation strategy (ADR-0005/0006).
 */
export interface EnrichmentOutcome {
  status: EnrichmentStatus;
  source: EnrichmentSource;
  category: TicketCategory;
  priority: TicketPriority;
  summary: string;
  confidence: number;
}

/**
 * The pipeline's seam to the enrichment layer. The processor depends only on this
 * interface; the concrete provider is swapped per build phase:
 *  - core engine: a trivial placeholder (this phase),
 *  - AI layer:    a Mistral-backed enricher with circuit breaker + fallback.
 * Keeping it behind a token means adding the AI is a provider swap, not surgery
 * on the pipeline.
 */
export interface Enricher {
  enrich(ticket: TicketEntity): Promise<EnrichmentOutcome>;
}

export const ENRICHER = Symbol('ENRICHER');
