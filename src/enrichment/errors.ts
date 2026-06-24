/**
 * Every recoverable enrichment failure is funnelled into this one type:
 * network errors, timeouts, non-2xx responses, non-JSON bodies, AND schema
 * validation failures. Treating a malformed/unschematic model response as
 * *transient* (rather than a hard error) is deliberate (ADR-0005): the retry
 * loop may get a well-formed answer next time, and the circuit breaker counts it
 * as a failure so a model that is consistently returning garbage trips the
 * breaker and we degrade — instead of trusting bad output.
 */
export class TransientEnrichmentError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientEnrichmentError';
  }
}
