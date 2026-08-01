import { TicketEntity } from '../tickets/entities/ticket.entity';
import {
  EnrichmentSource,
  EnrichmentStatus,
  TicketCategory,
  TicketPriority,
} from '../tickets/ticket.enums';

/**
 * The result of classifying a ticket. The shape is identical whether it came
 * from the model or the rule-based fallback, which is what lets a degraded
 * result stand in for a real one without the pipeline caring (ADR-0005/0006).
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
 * The pipeline's seam to the enrichment layer. The processor depends on this
 * interface and nothing else; `EnrichmentModule` binds the token to the
 * Mistral-backed enricher (with its circuit breaker and fallback). Swapping the
 * implementation — for another provider, or for a fault-injecting wrapper in the
 * tests — is a provider binding, not a change to the pipeline.
 */
export interface Enricher {
  enrich(ticket: TicketEntity): Promise<EnrichmentOutcome>;
}

export const ENRICHER = Symbol('ENRICHER');
