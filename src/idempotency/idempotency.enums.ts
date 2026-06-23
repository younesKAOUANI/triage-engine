/**
 * State machine for an idempotency key (see ADR-0001):
 *
 *   (insert) ── PENDING ──> COMPLETED        success: response is replayable
 *                  │
 *                  └──────> FAILED            terminal failure: a replay may retry
 *
 * A PENDING row also carries a lease (locked_at); if it is older than the
 * configured lease window it is considered abandoned and may be re-driven, which
 * prevents a crashed worker from wedging a key in PENDING forever.
 */
export enum IdempotencyStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
