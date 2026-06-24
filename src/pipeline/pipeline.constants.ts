export const PIPELINE_QUEUE = 'ticket-pipeline';
export const ENRICH_TICKET_JOB = 'enrich-ticket';

/**
 * Side-effect event types. The two are deliberately distinct so their outbox
 * dedup keys never collide: the first triage notification and a later AI upgrade
 * are different events, not a re-fire of the same one (ADR-0005).
 */
export const SIDE_EFFECT_TRIAGED = 'ticket.triaged';
export const SIDE_EFFECT_UPGRADED = 'ticket.enrichment_upgraded';

/**
 * The job payload carried through Redis. It is intentionally self-contained: the
 * idempotency key travels with the job so that a DLQ replay can re-enter the
 * pipeline through the SAME key (and therefore cannot create a duplicate ticket).
 * The correlation id is copied in here because Redis is a process boundary — the
 * AsyncLocalStorage context does not cross it, so we re-establish it in the worker.
 */
export interface PipelineJobData {
  idempotencyKey: string;
  ticketId: string;
  eventId: string;
  correlationId?: string;
  /** Set when this job originated from a DLQ replay; for tracing only. */
  replayOfDeadLetterId?: string;
  /**
   * Set on a delayed re-enrichment job that tries to upgrade a DEGRADED ticket to
   * an AI classification. 1-based; capped by ENRICHMENT_UPGRADE_MAX_ATTEMPTS.
   */
  upgradeAttempt?: number;
}
