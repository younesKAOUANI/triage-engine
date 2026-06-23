/** A message handed to a dispatcher for delivery. */
export interface DispatchMessage {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Consumer-side idempotency token; sent so the target can deduplicate. */
  dedupKey: string;
}

/**
 * The transport that actually delivers a side effect. Abstracted behind a token
 * so the relay is agnostic to the target (webhook today; could be a message bus,
 * email, etc.) and so tests can substitute a fake. A dispatch MUST throw on
 * failure — the relay treats a thrown error as "not delivered" and reschedules.
 */
export interface OutboxDispatcher {
  dispatch(message: DispatchMessage): Promise<void>;
}

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
