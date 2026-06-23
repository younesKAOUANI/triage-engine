/**
 * Domain enums shared by the AI enricher and the rule-based fallback. Defining
 * them once guarantees both classifiers — and the persisted column — speak the
 * exact same vocabulary, which is what makes a fallback result a true drop-in for
 * an AI result.
 */

export enum TicketCategory {
  BILLING = 'BILLING',
  TECHNICAL = 'TECHNICAL',
  ACCOUNT = 'ACCOUNT',
  FEATURE_REQUEST = 'FEATURE_REQUEST',
  COMPLAINT = 'COMPLAINT',
  OTHER = 'OTHER',
}

export enum TicketPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

/**
 * Lifecycle of a ticket's enrichment:
 *  - PENDING:  created, enrichment not yet attempted.
 *  - ENRICHED: an AI classification is stored. Terminal (happy path).
 *  - DEGRADED: the AI was unavailable, so a fallback classification is stored and
 *              an AI re-enrichment is queued. This is the spec's "enrichment_pending"
 *              state — the ticket is usable now and will be upgraded later. The
 *              ticket is NEVER dropped because the AI is down.
 *  - FAILED:   enrichment could not be completed even by fallback. Terminal.
 */
export enum EnrichmentStatus {
  PENDING = 'PENDING',
  ENRICHED = 'ENRICHED',
  DEGRADED = 'DEGRADED',
  FAILED = 'FAILED',
}

export enum EnrichmentSource {
  AI = 'AI',
  FALLBACK = 'FALLBACK',
}
