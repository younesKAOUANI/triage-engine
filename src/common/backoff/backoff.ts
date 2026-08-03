export interface BackoffOptions {
  baseMs: number;
  maxMs?: number;
}

/**
 * Exponential backoff with "equal jitter" (AWS architecture blog variant):
 *
 *   half  = min(maxMs, base * 2^(attempt-1)) / 2
 *   delay = half + random(0, half)
 *
 * The exponential term spreads retries out as failures persist; the jitter half
 * de-synchronises many clients/jobs that failed at the same instant, so they
 * don't retry in a thundering herd. `attempt` is 1-based (the 1st retry).
 *
 * Used in three places that all need the same behaviour: BullMQ pipeline retries,
 * the outbox relay's redelivery schedule, and the in-call Mistral retry loop.
 */
export function backoffWithJitter(
  attempt: number,
  opts: BackoffOptions,
): number {
  const cap = opts.maxMs ?? Number.MAX_SAFE_INTEGER;
  const exp = Math.min(cap, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return Math.floor(half + Math.random() * half);
}
