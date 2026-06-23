# ADR-0002: ORM choice — TypeORM over Prisma

Status: Accepted

## Context

The project needs a Postgres data layer for NestJS with explicit migrations (not
schema sync). The realistic candidates are Prisma and TypeORM. This is not a
generic "which ORM is better" question — it depends entirely on what this
particular system is dominated by.

## Decision

Use **TypeORM**.

The deciding factor is that the heart of this project is hand-tuned transactional
SQL, and TypeORM exposes it as a first-class citizen:

- `SELECT … FOR UPDATE SKIP LOCKED` is available directly on the QueryBuilder.
  It is the backbone of the outbox relay (claim a batch without two relays
  fighting) and the stale-lease recovery. In Prisma this requires dropping to
  `$queryRaw`, i.e. leaving the abstraction precisely where the interesting logic
  is — which would read as a workaround rather than a deliberate design.
- The `QueryRunner` gives explicit transaction control, so "write the state
  change and the outbox row in the *same* transaction" is obvious and reviewable.
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
    lifecycle by hand. Reviewers familiar with TypeORM will check for exactly this.
  - TypeORM's raw `query()` has inconsistent return shapes for `RETURNING` DML
    (see ADR-0001). We avoid the trap by using typed QueryBuilder results.
