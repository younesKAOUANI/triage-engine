import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation context propagated across every async boundary in the pipeline.
 *
 * A request (or a job, or a relay tick) runs inside `correlationStorage.run()`,
 * so any code it transitively calls — services, the BullMQ processor, the
 * Mistral client — can read the same correlation id without it being threaded
 * through every function signature. The Pino `mixin` (see logging config) reads
 * this store on every log line, which is how one id ends up stamped on the whole
 * lifecycle of an event, including the LLM call.
 *
 * Crossing process boundaries (HTTP -> queue) is NOT automatic: the id is copied
 * into the BullMQ job payload at enqueue time and re-established inside the worker
 * via `runWithCorrelation`.
 */
export interface CorrelationStore {
  correlationId: string;
}

export const CORRELATION_HEADER = 'x-correlation-id';

export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

/** Run `fn` with a correlation id in scope. Generates one if not provided. */
export function runWithCorrelation<T>(
  correlationId: string | undefined,
  fn: () => T,
): T {
  return correlationStorage.run(
    { correlationId: correlationId ?? randomUUID() },
    fn,
  );
}

/** Current correlation id, or undefined when called outside any scope. */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
