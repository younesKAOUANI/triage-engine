import { backoffWithJitter } from '../common/backoff/backoff';

/**
 * Custom BullMQ backoff strategy: exponential + jitter (shared util). Registered
 * on the worker and selected per-job via `backoff: { type: 'custom' }`.
 *
 * Env is read lazily (not captured at import time) so the strategy picks up the
 * configured values even when this module is imported before the environment is
 * fully loaded, e.g. in tests.
 */
export function pipelineBackoffStrategy(attemptsMade: number): number {
  const baseMs = Number(process.env.PIPELINE_BACKOFF_BASE_MS ?? 2000);
  const maxMs = Number(process.env.PIPELINE_BACKOFF_MAX_MS ?? 60000);
  return backoffWithJitter(attemptsMade, { baseMs, maxMs });
}
