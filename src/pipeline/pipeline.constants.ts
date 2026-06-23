export const PIPELINE_QUEUE = 'ticket-pipeline';
export const ENRICH_TICKET_JOB = 'enrich-ticket';

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
}
