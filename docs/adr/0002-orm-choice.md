# ADR-0002: ORM choice — TypeORM over Prisma

Status: Accepted

## Context

The project needs a Postgres data layer for NestJS with explicit migrations (not
schema sync). The realistic candidates are Prisma and TypeORM. This is not a
generic "which ORM is better" question — it depends entirely on what this
particular system is dominated by.

## Decision

Use **TypeORM**.

The deciding factor is that this system is dominated by hand-written
transactional SQL, and TypeORM lets that sit alongside the entity layer instead
of fighting it:

- `QueryRunner` gives explicit transaction control, and its `EntityManager` runs
  both entity operations and raw SQL on the *same* connection. That is what makes
  "update the ticket and write the outbox row in one transaction" a plain piece
  of code rather than an arrangement I have to reason about.
- The relay's claim query (`SELECT … FOR UPDATE SKIP LOCKED`) is written as raw
  SQL through that same manager. I did not try to express it through the
  QueryBuilder: `setLock('pessimistic_write')` covers `FOR UPDATE`, but the
  `SKIP LOCKED` variant the relay depends on is clearer written out, and the
  point is that doing so costs nothing here — it is still the same transaction,
  the same manager, no second connection path.
- `@nestjs/typeorm` integrates natively; entities co-locate with their modules.

**Honest trade-off**: if this were a typical CRUD product, I would most likely
reach for Prisma — its generated types and migration ergonomics are genuinely
nicer for everyday application code. I am choosing the less-fashionable tool here
*because the problem is dominated by locking and transactional correctness*, and
for that TypeORM's lower-level control wins. Picking a tool for a specific reason
beats picking the default.

## Consequences

- **Positive**: lock-aware SQL, same-transaction outbox writes, and a single
  options builder shared by the app and the migration CLI all read as intentional.
- **Negative / accepted**:
  - Weaker end-to-end type-safety than Prisma; entity/column types are
    hand-declared.
  - TypeORM's `QueryRunner` is a known footgun — forget `release()` in a `finally`
    and you leak pooled connections until the app wedges. Mitigated by funnelling
    **every** manual transaction through one `runInTransaction` helper
    (`src/common/database/transaction.helper.ts`); no call site manages that
    lifecycle by hand.
  - TypeORM's raw `query()` has inconsistent return shapes for `RETURNING` DML
    (see ADR-0001). We avoid the trap by using typed QueryBuilder results.
