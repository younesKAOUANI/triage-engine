# ADR-0001: Idempotency strategy — unique key + status state machine

Status: Accepted

## Context

Events arrive over a network from clients and upstream systems that retry. The
same logical submission can therefore reach `POST /events` more than once —
sequentially (a client retry after a timeout) or concurrently (two retries in
flight at once). The system must guarantee that one submission produces **exactly
one** ticket and **exactly one** downstream side effect, no matter how many times
it is delivered, and it must do so under genuine concurrency, not just in the
happy sequential case.

## Decision

A dedicated `idempotency_keys` table with a `UNIQUE(idempotency_key)` constraint
and a small state machine: `PENDING → COMPLETED | FAILED`.

- **The key**: client-provided (`Idempotency-Key` header or body field) or, if
  absent, derived as a SHA-256 of the canonical (key-sorted) request content.
- **Claiming** is `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
  The unique constraint is the actual concurrency guard: of N concurrent identical
  requests, the database lets exactly one insert succeed; the rest get nothing and
  read the existing row.
- **Branching on the existing row**:
  - `request_hash` differs → **409 Conflict** (same key, different payload — a
    real client bug we refuse to silently mask).
  - `COMPLETED` → replay the stored response (`response_code` + `response_body`);
    do no new work.
  - `PENDING` with a fresh lease → **in flight elsewhere**; return 202 without
    duplicating work.
  - `PENDING` with an expired lease, or `FAILED` → **reclaim** and re-drive.
- **Lease**: a claimed row stamps `locked_at`. A `PENDING` row whose `locked_at`
  is older than `IDEMPOTENCY_LEASE_MS` (default **5 minutes**) is considered
  abandoned (crashed worker) and may be reclaimed. Reclaim is a conditional
  `UPDATE … WHERE (stale-or-failed)`; Postgres re-checks the predicate under the
  row lock, so concurrent reclaimers serialise and only one wins.
- **Crash-safety of re-drive**: ingestion locks the idempotency row
  `FOR UPDATE` before creating the ticket and only creates it if `ticket_id` is
  not already set. Combined with a deterministic BullMQ `jobId` (= the key) and
  the outbox `dedup_key`, a reclaim-driven re-run reuses the existing ticket and
  re-emits nothing — so even a double-drive cannot duplicate.

## Consequences

- **Positive**: correctness lives in the database, not in application locks or a
  distributed lock service. Verified live: 12 concurrent identical submissions
  produced exactly 1 event, 1 ticket, and 1 delivered side effect, with 1
  `accepted` + 11 `replayed` responses.
- **Negative / accepted**:
  - The `idempotency_keys` table grows unbounded. Retention/reaping is **not**
    implemented here — see README "Limitations". Production would reap `COMPLETED`
    rows older than the client's retry window.
  - The lease is a tuning knob: too short risks double-driving a slow-but-alive
    worker (safe here because re-drive is idempotent, but wasteful); too long
    delays recovery of a genuinely crashed one. 5 min is comfortably longer than
    the sub-second ingestion path.
- **Implementation note (learned the hard way)**: TypeORM's raw `query()` returns
  `[rows, affectedCount]` for `UPDATE … RETURNING` but a flat rows array for
  `INSERT … RETURNING`. A naive `.length` check on the reclaim made it always
  "succeed", handing `NEW` to every concurrent loser. The reclaim and DLQ flip
  now use the typed `UpdateResult.affected` instead. Caught by a live concurrency
  smoke test against real Postgres — a reason the test suite uses a real database,
  not mocks.
