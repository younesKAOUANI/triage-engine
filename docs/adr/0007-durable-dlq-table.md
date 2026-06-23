# ADR-0007: Durable DLQ table over BullMQ's failed set

Status: Accepted

## Context

Jobs that exhaust their retries must not vanish. BullMQ already keeps a "failed"
set in Redis, so one option is to lean on it. But that set is a poor operational
surface: it is awkward to query and filter, it carries Redis's retention/eviction
semantics rather than ours, and it disappears if Redis is flushed. For a system
meant to demonstrate operational thinking, "where do permanently-failed jobs go,
and how do we inspect and replay them?" deserves a first-class answer.

## Decision

Mirror exhausted jobs into a dedicated `dead_letters` Postgres table.

- The row is written by the worker's terminal `failed` handler — only once
  `attemptsMade >= opts.attempts`, i.e. after BullMQ has truly given up (earlier
  failures just count a retry).
- It captures full triage context: the original job payload **verbatim**, the
  error message and stack, the attempt count, the originating BullMQ `job_id`
  (for cross-referencing Redis/logs), and the idempotency key.
- It is the surface for `GET /dlq` (queryable, filterable by status) and
  `POST /dlq/:id/replay`.
- **Replay correctness** is the subtle part, and it is where the DLQ intersects
  idempotency (ADR-0001): replay re-enqueues using the **original idempotency
  key** carried in the stored payload. The existing ticket is therefore reused
  (no duplicate) and the outbox `dedup_key` absorbs the re-emitted side effect.
  Replay flips `PENDING → REPLAYED` atomically *before* enqueuing (so two
  concurrent replays can't both fire), and reverts to `PENDING` if the enqueue
  throws.

## Consequences

- **Positive**: durable, queryable, replayable failure records that survive Redis;
  a clean replay endpoint. Verified live: replaying a dead letter for an existing
  ticket reprocessed it (attempts 1→2) but created no new ticket and no duplicate
  side effect; a second replay returned 409.
- **Negative / accepted**:
  - Some duplication between Redis's failed set and our table. We treat the table
    as the source of truth and keep BullMQ's failed jobs only briefly, for
    low-level inspection.
  - The replay uses a fresh BullMQ `jobId` (`<key>:replay:<deadLetterId>`) so the
    job actually re-runs (a duplicate of the original deterministic id would be
    suppressed); correctness still rests on the idempotency key in the payload,
    not the BullMQ id.
