# ADR-0008: Outbox relay dispatch — polling with SKIP LOCKED

Status: Accepted

## Context

The outbox (ADR-0004) needs a relay that turns `PENDING` rows into delivered side
effects. Two questions: how does the relay *find* due rows, and how does it avoid
double-dispatch when more than one relay instance runs?

The main alternative to polling is Postgres `LISTEN/NOTIFY` (push). It has lower
latency but couples dispatch to a live notification connection, loses events that
fire while no listener is connected (so you still need a polling safety net for
durability), and is fiddlier to scale.

## Decision

Poll on a short interval, claiming a batch with row locks:

```sql
SELECT ... FROM outbox_messages
 WHERE status = 'PENDING' AND next_attempt_at <= now()
 ORDER BY next_attempt_at
 FOR UPDATE SKIP LOCKED
 LIMIT :batch
```

- `FOR UPDATE` locks the claimed rows; **`SKIP LOCKED`** makes a second relay
  instance step over rows already claimed by the first instead of blocking on
  them. That one clause is what lets the relay scale horizontally with zero
  coordination and no contention-driven double dispatch.
- A **partial index** `ON (next_attempt_at) WHERE status = 'PENDING'` keeps the
  poll cheap and makes `SENT`/`FAILED` rows fall out of the scan automatically.
- Backoff is encoded in `next_attempt_at` (exponential + jitter); the poll simply
  respects it. After a full batch the relay drains again immediately; otherwise it
  waits `OUTBOX_RELAY_POLL_INTERVAL_MS`.
- Dispatch happens **inside** the claim transaction, which is what gives the
  at-least-once guarantee (ADR-0004): a crash before commit returns the row to
  `PENDING`.

## Consequences

- **Positive**: simple, durable, horizontally scalable, and robust to listener
  downtime. No event is missed because nothing was listening. Verified live: side
  effects dispatched exactly once per `dedup_key`.
- **Negative / accepted**:
  - The row lock is held across the HTTP dispatch, so a slow target ties up that
    row (and a transaction) for the duration. Fine for a single relay at modest
    volume — bounded by the per-dispatch timeout. **At high throughput** the move
    is *claim-then-dispatch*: in one short transaction mark a batch as `CLAIMED`
    with a lease, commit, dispatch outside the transaction, then mark `SENT`
    (reclaiming expired `CLAIMED` leases like the idempotency path). Noted in the
    README "Limitations" as a deliberate next step rather than built now.
  - Polling adds up to one interval of latency versus `LISTEN/NOTIFY`. Acceptable
    for notifications; the interval is configurable.
