# ADR-0007: Durable DLQ table over BullMQ's failed set

Status: Accepted

## Context

Jobs that exhaust their retries must not vanish. BullMQ already keeps a "failed"
set in Redis, so one option is to lean on it. But that set is a poor operational
surface: it is awkward to query and filter, it carries Redis's retention/eviction
semantics rather than ours, and it disappears if Redis is flushed. "Where do
permanently-failed jobs go, and how do I inspect and replay them?" is a question
worth a real answer, not a Redis key I have to remember how to inspect.

## Decision

Mirror exhausted jobs into a dedicated `dead_letters` Postgres table.

- The row is written by the worker's `failed` handler, but **only when the
  failure is terminal** — earlier failures just count a retry.

  Deciding "terminal" is subtler than it first appears, and getting it wrong
  reopens exactly the loss this ADR exists to close. `attemptsMade >=
  opts.attempts` is **not** sufficient: BullMQ retires jobs permanently on
  several paths that never increment `attemptsMade`. A stalled job (worker crash
  or lost lock) has its *stall* counter bumped instead, and once past
  `maxStalledCount` it gets a deferred-failure marker that the worker converts
  into an `UnrecoverableError` **before the processor runs** — so it lands in the
  failed set for good with `attemptsMade` of 1 against a budget of 5.
  `job.discard()`, an explicitly thrown `UnrecoverableError`, and a backoff
  strategy returning `-1` end the same way. Read naively, every one of those
  looks like "an attempt failed, more remain", and the job is dropped with no
  `dead_letters` row.

  The handler therefore classifies on three signals: the error being
  unrecoverable (by `instanceof` **and** by name, since a duplicate `bullmq` copy
  in the dependency tree defeats `instanceof`), then attempt exhaustion, then a
  bounded `job.isFailed()` probe as the definitional backstop — if the job is
  sitting in the failed set, it is done.
- **Failing safe.** The `isFailed()` probe needs Redis, which may be the very
  thing that is broken. If classification cannot complete, the handler assumes
  *terminal*. The asymmetry is deliberate: a spurious dead letter is harmless and
  self-correcting, because replay re-enters through the original idempotency key
  and can duplicate neither the ticket nor the side effect — whereas a missed
  dead letter is a silent loss. Failure to *classify* and failure to *persist*
  are reported separately, so only a genuinely unwritable record raises the
  "job lost" alarm.
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
  - Some duplication between Redis's failed set and our table. The table is the
    operational source of truth, but the failed set is **not** merely for
    low-level inspection: the terminality backstop reads it. That makes
    `removeOnFail` load-bearing — it must retain a failed job long enough for the
    handler to observe it, so `true`, `{ age: 0 }` and `{ count: 0 }` would each
    silently defeat the backstop. Every enqueue path uses `{ age: 86400 }`.
  - The replay uses a fresh BullMQ `jobId` (`<key>:replay:<deadLetterId>`) so the
    job actually re-runs (a duplicate of the original deterministic id would be
    suppressed); correctness still rests on the idempotency key in the payload,
    not the BullMQ id.
