# ADR-0004: Transactional outbox for reliable side effects

Status: Accepted

## Context

When a ticket is triaged we must emit a side effect (a notification/webhook). The
naive approach — commit the state change, then make the HTTP call — has a fatal
gap: if the process dies between the commit and the call, the state change is
durable but the notification is lost forever. The mirror approach (call first,
then commit) can fire a notification for a change that then rolls back. Neither is
acceptable for a system whose theme is "nothing is silently lost".

## Decision

Use the **transactional outbox** pattern.

- The side effect is written as a row in `outbox_messages` **in the same database
  transaction** as the state change that warrants it (`OutboxService.emit` takes
  the caller's `EntityManager`; there is deliberately no "emit outside a
  transaction" method). So a committed state change always has its pending
  notification, and a rolled-back one has neither.
- A separate **relay** polls the outbox and dispatches (see ADR-0008 for the poll
  mechanism), marking rows `SENT`, or rescheduling them with exponential backoff +
  jitter, or — after `OUTBOX_MAX_ATTEMPTS` (default 10) — moving them to a
  terminal `FAILED` state.
- Delivery is **at-least-once**: dispatch happens inside the transaction that
  marks the row `SENT`, so a crash after the HTTP call but before commit rolls
  back and the row is redelivered. The consumer deduplicates.
- **Consumer-side idempotency**: every message carries a `dedup_key`, sent as the
  `Idempotency-Key` header. It is derived deterministically and collision-safely
  as `${aggregate_type}:${aggregate_id}:${event_type}:${version}`. Because it is
  deterministic, re-emitting the *same* logical effect (a reprocessed job, a DLQ
  replay) collapses onto the same key via `ON CONFLICT (dedup_key) DO NOTHING` —
  one triage produces one notification. Because `version` is part of it, two
  *distinct* effects can never accidentally collide and silently drop one.

## Consequences

- **Positive**: a side effect can neither be lost nor fire spuriously. Verified
  live: a ticket reprocessed via DLQ replay re-ran (attempts incremented) yet
  produced no second outbox row and no second delivery.
- **Negative / accepted**:
  - At-least-once means duplicates are possible; the consumer **must** be
    idempotent on `dedup_key`. The bundled `_sink` simulates exactly such a
    consumer.
  - A permanently `FAILED` message means an at-least-once guarantee was abandoned
    for that row. That is surfaced as the `outbox_messages_failed_total` metric —
    the thing an alert should fire on — rather than failing silently.
  - The relay holds the row lock across the HTTP dispatch (see ADR-0008 for why
    that is fine here and what you'd change at high throughput).
