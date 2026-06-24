# Architecture Decision Records

Each non-obvious decision in this project is recorded here in the standard
Context / Decision / Consequences format. They are the "why" behind the code; read
them before the implementation.

| # | Decision | One-line rationale |
| --- | --- | --- |
| [0001](0001-idempotency-strategy.md) | Idempotency strategy | Unique key + status state machine; the race is resolved in the database, not in app locks |
| [0002](0002-orm-choice.md) | ORM choice | TypeORM over Prisma — the problem is dominated by hand-tuned transactional SQL |
| [0003](0003-circuit-breaker.md) | Circuit breaker | opossum over a hand-rolled state machine |
| [0004](0004-outbox-pattern.md) | Transactional outbox | Side effect written in the same transaction as the state change |
| [0005](0005-ai-failure-handling.md) | AI failure handling | Validate-as-transient, never-throw degrade, distinct upgrade event, decoupled re-queue |
| [0006](0006-fallback-classifier.md) | Fallback classifier | Rule-based, same shape as AI output, keeps tickets usable during an outage |
| [0007](0007-durable-dlq-table.md) | Durable DLQ | A queryable Postgres table over BullMQ's failed set; replay through the same key |
| [0008](0008-outbox-relay-polling.md) | Relay dispatch | Polling with `FOR UPDATE SKIP LOCKED` over `LISTEN/NOTIFY` |
| [0009](0009-degraded-reconciliation-sweep.md) | Reconciliation sweep | Re-drive tickets stranded in DEGRADED; close the last "silently stuck" path |
