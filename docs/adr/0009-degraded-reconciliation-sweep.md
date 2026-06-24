# ADR-0009: Reconciliation sweep for stranded DEGRADED tickets

Status: Accepted

## Context

Graceful degradation (ADR-0005) classifies a ticket with the fallback when the AI
is down and schedules a delayed BullMQ job to upgrade it later. That covers the
normal case. But the upgrade chain can be *lost*, leaving a ticket permanently
DEGRADED:

- the upgrade re-queue is in Redis, which can be flushed or evict the delayed job;
- a crash in the narrow window between committing the DEGRADED state and enqueuing
  the upgrade leaves no job scheduled;
- the upgrade attempt cap (`ENRICHMENT_UPGRADE_MAX_ATTEMPTS`) is reached while the
  AI is still down.

This is the **one** path that can quietly violate the project's "nothing is ever
silently lost" guarantee: a ticket isn't *lost* (it keeps a usable fallback
classification), but it can stay degraded forever with nobody noticing. Postgres
holds the durable truth (`enrichment_status = 'DEGRADED'`); Redis holds the only
thing scheduled to fix it. When those disagree, the database should win.

## Decision

A periodic **reconciliation sweep** that treats the database as the source of
truth and re-drives stranded tickets.

- On an interval (`RECONCILE_SWEEP_INTERVAL_MS`), scan for tickets that have been
  `DEGRADED` longer than `RECONCILE_DEGRADED_AFTER_MS`, in bounded batches
  (`RECONCILE_BATCH_SIZE`).
- For each, re-enqueue a pipeline job through the ticket's original idempotency key
  (joined from its event), restarting the upgrade chain. Reprocessing is idempotent
  (existing ticket reused, outbox dedups), so a sweep can never duplicate a ticket
  or a side effect — it can only upgrade or re-degrade.
- The reconcile job uses a per-ticket jobId (`<key>:reconcile`) so concurrent
  sweeps or overlapping cycles collapse to one in-flight reconcile per ticket — no
  pile-up.
- It is **rate-limited by design** (interval + batch size + per-ticket dedup), so
  even a large backlog after an outage drains steadily rather than stampeding the
  AI the moment it recovers — the same anti-thundering-herd reasoning as ADR-0005.

This mirrors how idempotency-key retention was handled: the edge is named and, in
this case, closed, because it is the only seam in the central invariant.

## Consequences

- **Positive**: closes the last "silently stuck" path. A DEGRADED ticket is now
  *guaranteed* to be retried until it upgrades (or the AI is genuinely, durably
  gone), regardless of Redis state or crash timing. The sweep is a self-healing
  reconciler between the durable store and the queue. Verified by an integration
  test: a ticket forced into a stale DEGRADED state is upgraded to AI by the sweep.
- **Negative / accepted**:
  - The sweep runs on every instance; with multiple instances the per-ticket
    `<key>:reconcile` jobId keeps them from double-enqueuing, but the scan itself is
    duplicated work. Fine at this scale; a leader-election or advisory-lock guard
    would remove it if needed.
  - It polls rather than reacting to an event. Acceptable: it is a backstop for the
    rare lost-upgrade case, not the primary path, so latency on the order of the
    sweep interval is fine.
