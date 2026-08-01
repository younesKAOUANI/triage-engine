# Architecture — Triage Engine

Reference documentation for the engine's design, mechanics and failure
behaviour. The README covers what it does; this covers how. Claims here point at
a file and line so they can be checked.

---

## 1. What this system is

A support-ticket triage service. Clients POST ticket events; the service
persists them, classifies each ticket with an LLM (category, priority, summary,
confidence), stores the result, and notifies a downstream system.

Described that way it sounds like a CRUD app with a model call attached. The
proportions say otherwise: the Mistral integration is about 400 lines, and the
rest is the machinery that keeps a ticket from being dropped, duplicated or left
half-processed when something fails.

### The problem it solves

Events arrive from systems you do not control. Those systems retry on timeout and
deliver at-least-once. Workers crash mid-job. The notification target returns
500s. The model is sometimes slow, sometimes down, and sometimes returns
confident nonsense that does not match the schema.

There are seven distinct points where work can go missing. Each has a mechanism:

| Where work could be lost | Mechanism | ADR |
| --- | --- | --- |
| Duplicate / concurrent submissions duplicating work | Idempotency ledger: `UNIQUE` key + status machine, race resolved in the DB | [0001](adr/0001-idempotency-strategy.md) |
| A committed state change whose notification never fires | Transactional outbox: side effect written in the same transaction as the state change | [0004](adr/0004-outbox-pattern.md) |
| A side effect lost between commit and HTTP call | Outbox relay: at-least-once dispatch, `FOR UPDATE SKIP LOCKED` | [0008](adr/0008-outbox-relay-polling.md) |
| A job that exhausts retries vanishing | Durable DLQ table + replay endpoint | [0007](adr/0007-durable-dlq-table.md) |
| A ticket dropped because the AI is down | Graceful degradation: rule-based fallback now, AI upgrade re-queued later | [0005](adr/0005-ai-failure-handling.md) / [0006](adr/0006-fallback-classifier.md) |
| Garbage model output persisted as truth | Every response zod-validated; failure treated as transient | [0005](adr/0005-ai-failure-handling.md) |
| A ticket stuck DEGRADED if its upgrade job is lost | Reconciliation sweep, DB as source of truth | [0009](adr/0009-degraded-reconciliation-sweep.md) |

### The central invariant

Nothing is ever silently lost. Both halves of that matter.

*Lost*: work has to end up somewhere durable and queryable, whether that is a
row, a dead letter, a metric, or at minimum a structured log line carrying the
full payload.

*Silently*: sometimes giving up is unavoidable, since a notification can genuinely
exhaust its retries. What is not acceptable is giving up without a signal, so
every abandonment path increments a counter meant to be alerted on.

The rest of this document is largely the same idea applied in different places.

---

## 2. Topology

```
                    ┌──────────────────────────────────────────┐
   POST /events ──► │ EventsController → EventsService         │
                    │   hash payload → claim idempotency key   │
                    └───────┬──────────────────────────┬───────┘
                            │ NEW                      │ REPLAY / IN_FLIGHT / CONFLICT
                            ▼                          └──► 202 {replayed|processing} / 409
              ┌─────────────────────────────┐
              │ TX: INSERT event + ticket   │
              │     attach ticket to key    │
              └─────────────┬───────────────┘
                            ▼
                  BullMQ enqueue (jobId = idempotency key)
                            │
                            ▼
              ┌─────────────────────────────┐        ┌──────────────────┐
              │ TicketProcessor (conc. 5)   │───────►│ AiEnricher       │
              │   load ticket, note prior   │        │  breaker→Mistral │
              │   enrich (never throws)     │◄───────│  or FallbackClf  │
              └─────────────┬───────────────┘        └──────────────────┘
                            ▼
              ┌─────────────────────────────┐
              │ TX: UPDATE ticket           │  ← one transaction, both writes
              │   + INSERT outbox_messages  │
              └─────────────┬───────────────┘
                            ▼
              ┌─────────────────────────────┐
              │ OutboxRelay (poll loop)     │──► POST webhook ──► /_sink/webhook
              │  FOR UPDATE SKIP LOCKED     │
              └─────────────────────────────┘

   Recovery paths:  retries exhausted ──► dead_letters ──(POST /dlq/:id/replay)──┐
                    stuck DEGRADED ─────► ReconcileSweeper ──────────────────────┘
                                                                    (re-enter pipeline)
```

Runtime shape: a **single Node process** hosts the HTTP API, the BullMQ worker,
the outbox relay, and the reconciliation sweeper. They are separate modules with
no shared mutable state — the only coordination is Postgres and Redis — so
splitting them into separate deployments is a wiring change, not a redesign.

---

## 3. Module map

| Directory | Responsibility | Most important file |
| --- | --- | --- |
| `src/events` | HTTP ingestion, orchestrating the claim→persist→enqueue sequence | [events.service.ts](../src/events/events.service.ts) |
| `src/idempotency` | The ledger and its state machine; all concurrency safety | [idempotency.service.ts](../src/idempotency/idempotency.service.ts) |
| `src/tickets` | Ticket entity, enums, read API | [ticket.enums.ts](../src/tickets/ticket.enums.ts) |
| `src/pipeline` | BullMQ worker, producer, retry policy, observer | [ticket.processor.ts](../src/pipeline/ticket.processor.ts) |
| `src/pipeline/dlq` | Durable dead-letter table, list/replay API | [dlq.service.ts](../src/pipeline/dlq/dlq.service.ts) |
| `src/enrichment` | Mistral client, circuit breaker, fallback, schema validation | [ai.enricher.ts](../src/enrichment/ai.enricher.ts) |
| `src/outbox` | Transactional outbox write + relay + dispatchers + demo sink | [outbox.relay.ts](../src/outbox/outbox.relay.ts) |
| `src/observability` | Prometheus registry and every metric | [metrics.service.ts](../src/observability/metrics.service.ts) |
| `src/health` | Liveness vs readiness probes | [health.controller.ts](../src/health/health.controller.ts) |
| `src/common` | Backoff, correlation (ALS), transaction helper, canonical hashing, logging | [transaction.helper.ts](../src/common/database/transaction.helper.ts) |
| `src/config` | zod env schema, TypeORM datasource, migration-on-boot | [env.validation.ts](../src/config/env.validation.ts) |
| `src/migrations` | Hand-written DDL (never `synchronize`) | [1700000000000-InitialSchema.ts](../src/migrations/1700000000000-InitialSchema.ts) |

**The seam that matters:** the processor depends only on the `Enricher` interface
behind the `ENRICHER` symbol ([enricher.port.ts:35](../src/pipeline/enricher.port.ts:35)).
`EnrichmentModule` binds it to `AiEnricher`. Adding, replacing, or fault-injecting
the AI is a provider swap, not surgery on the pipeline — which is exactly how the
integration suite injects failures.

---

## 4. Data model

Five tables. The FK dependency is strictly one-directional —
`events ← tickets ← idempotency_keys` — so there is no cycle and the migration
has a clean topological order. `outbox_messages` and `dead_letters` reference
aggregates by id **without** an FK, deliberately: a side effect or a failure
record must outlive and be independent of the row that produced it.

### `events` — the immutable raw record
| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | `gen_random_uuid()` |
| `idempotency_key` | `text NOT NULL` | indexed; used by the sweeper's join |
| `payload` | `jsonb NOT NULL` | the verbatim request body |
| `source` | `text` | |
| `received_at` | `timestamptz NOT NULL` | |

### `tickets` — the domain aggregate
| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | |
| `event_id` | `uuid NOT NULL` | FK → `events(id)` `ON DELETE RESTRICT` |
| `subject`, `body` | `text NOT NULL` | |
| `requester_email` | `text` | |
| `enrichment_status` | enum | `PENDING\|ENRICHED\|DEGRADED\|FAILED`, default `PENDING`, indexed |
| `category`, `priority` | enum | null until enriched |
| `summary` | `text` | |
| `confidence` | `real` | |
| `enrichment_source` | enum | `AI\|FALLBACK` |
| `enrichment_attempts` | `integer NOT NULL DEFAULT 0` | incremented in SQL, not read-modify-write |
| `enriched_at`, `created_at`, `updated_at` | `timestamptz` | |

### `idempotency_keys` — the ledger
| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | |
| `idempotency_key` | `text` | **`UNIQUE`** — this constraint decides every race |
| `request_hash` | `text NOT NULL` | SHA-256 of the canonicalized payload |
| `status` | enum | `PENDING\|COMPLETED\|FAILED`, indexed |
| `ticket_id` | `uuid` | FK → `tickets(id)` `ON DELETE SET NULL` |
| `response_code` | `integer` | stored on completion |
| `response_body` | `jsonb` | replayed to duplicate callers |
| `locked_at` | `timestamptz` | the lease timestamp |

### `outbox_messages` — pending side effects
| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid PK` | |
| `aggregate_type`, `aggregate_id`, `event_type` | | identify the effect |
| `payload` | `jsonb NOT NULL` | includes `correlationId` |
| `status` | enum | `PENDING\|SENT\|FAILED`, default `PENDING` |
| `attempts` | `integer NOT NULL DEFAULT 0` | |
| `next_attempt_at` | `timestamptz NOT NULL DEFAULT now()` | the retry schedule |
| `dedup_key` | `text` | **`UNIQUE`** — collision-safe idempotence |
| `last_error`, `dispatched_at` | | |

**Partial index** — `ix_outbox_due ON (next_attempt_at) WHERE status = 'PENDING'`.
This is the relay's whole access path: `SENT` and `FAILED` rows fall out of the
index automatically, so it stays proportional to *undelivered* work rather than
to total history.

### `dead_letters` — the durable failure record
`queue`, `job_id`, `idempotency_key` (indexed), `payload jsonb`, `error_message`,
`error_stack`, `attempts_made`, `status` (`PENDING|REPLAYED`, indexed),
`failed_at`, `replayed_at`.

### State machines

**Idempotency key** ([idempotency.enums.ts](../src/idempotency/idempotency.enums.ts))
```
          INSERT ON CONFLICT DO NOTHING (winner)
  (none) ─────────────────────────────────────► PENDING
                                                  │
              markCompleted (after enqueue)       ├──► COMPLETED   [terminal, replayable]
              markFailed (ingest threw)           └──► FAILED
                                                          │
              conditional UPDATE reclaim                  ▼
              (FAILED always; PENDING once lease expired) → PENDING
```

**Ticket enrichment** ([ticket.enums.ts:34](../src/tickets/ticket.enums.ts:34))
```
  PENDING ──AI ok──────► ENRICHED   [terminal]
     │                      ▲
     └──AI fails──► DEGRADED┘   (delayed upgrade job, or reconciliation sweep)
                       └──AI still failing──► DEGRADED (no new side effect)
```
> `FAILED` exists in the enum and the Postgres type but **no code path assigns
> it**. That is a direct consequence of the never-throw enrichment contract: the
> enricher always produces at least a fallback classification. See §11.

---

## 5. The four flows

### 5.1 Happy path — new ticket to delivered notification

1. `POST /events`, `@HttpCode(202)` ([events.controller.ts:15-22](../src/events/events.controller.ts:15)).
   The key comes from the `Idempotency-Key` header, else `dto.idempotencyKey`,
   else the payload hash itself ([events.service.ts:51](../src/events/events.service.ts:51)).
2. `hashPayload({subject, body, requesterEmail, source, metadata})`
   ([events.service.ts:44-50](../src/events/events.service.ts:44)). The key is
   deliberately **not** part of the hash — the hash identifies *content*, which
   is what makes "same key, different body" detectable. Keys are sorted
   recursively before hashing ([canonical-hash.ts:9](../src/common/hash/canonical-hash.ts:9)).
3. `claim(key, hash)` → `INSERT … ON CONFLICT DO NOTHING … RETURNING id`
   ([idempotency.service.ts:51-63](../src/idempotency/idempotency.service.ts:51)).
   Non-empty `RETURNING` ⇒ **NEW**. Key is now `PENDING` with `locked_at = now()`.
4. `createTicketIfAbsent` opens a transaction, takes `FOR UPDATE` on the
   idempotency row ([idempotency.service.ts:125-138](../src/idempotency/idempotency.service.ts:125)),
   inserts the `event`, inserts the `ticket` (`PENDING`), and attaches
   `ticket_id` to the key — **all one commit**
   ([events.service.ts:136-163](../src/events/events.service.ts:136)).
5. Enqueue with `jobId = idempotencyKey`, `attempts = PIPELINE_MAX_ATTEMPTS`,
   custom backoff ([pipeline.producer.ts:32-42](../src/pipeline/pipeline.producer.ts:32)).
   BullMQ ignores a duplicate add for an existing jobId, so re-driving ingestion
   cannot create a second pipeline run.
6. `markCompleted(key, ticketId, 202, body)` — only **after** the ticket exists
   *and* the job is enqueued, so a replay always returns a fully wired result
   ([events.service.ts:118-120](../src/events/events.service.ts:118)). Key →
   `COMPLETED`. Response: `202 {status:'accepted', ticketId, jobId}`.
7. Worker picks it up (concurrency 5). It re-establishes the correlation scope
   from the job payload, loads the ticket, and records `prior = PENDING`
   ([ticket.processor.ts:63-83](../src/pipeline/ticket.processor.ts:63)).
8. `enricher.enrich(ticket)` → `{ENRICHED, AI, category, priority, summary, confidence}`.
9. **One transaction**: `UPDATE tickets SET … enrichment_attempts = enrichment_attempts + 1`
   **and** `INSERT INTO outbox_messages` with
   `dedup_key = ticket:<id>:ticket.triaged:v1`
   ([ticket.processor.ts:104-153](../src/pipeline/ticket.processor.ts:104)).
   Ticket → `ENRICHED`. If this transaction rolls back, *neither* the state change
   nor the notification exists — that is the entire point of the outbox.
10. Relay tick: `SELECT … WHERE status='PENDING' AND next_attempt_at <= now()
    ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 20`
    ([outbox.relay.ts:113-121](../src/outbox/outbox.relay.ts:113)).
11. Dispatch the webhook **inside** that transaction, then
    `UPDATE … SET status='SENT', dispatched_at=now()`
    ([outbox.relay.ts:140-158](../src/outbox/outbox.relay.ts:140)). The sink
    deduplicates on `dedup_key`.

### 5.2 Duplicate and concurrent submissions

`claim()` resolves four outcomes, entirely in SQL
([idempotency.service.ts:46-117](../src/idempotency/idempotency.service.ts:46)):

| Situation | Detection | Result |
| --- | --- | --- |
| First caller | `ON CONFLICT DO NOTHING` returns a row | `NEW` |
| Same key, different body | `existing.request_hash !== requestHash` | `CONFLICT` → **409** |
| Key already `COMPLETED` | status check | `REPLAY` → `202 {status:'replayed'}` with the stored `ticketId`/`jobId` |
| Key `PENDING`, lease fresh | reclaim UPDATE affects 0 rows | `IN_FLIGHT` → `202 {status:'processing', ticketId:null}` |
| Key `FAILED`, or `PENDING` past its lease | conditional UPDATE affects 1 row | `NEW` (re-driven) |

Under N concurrent identical POSTs exactly one caller wins the insert; the rest
read the row and take `IN_FLIGHT` (or `REPLAY` if the winner already finished).
**Exactly one ticket exists** — the invariant the suite actually asserts.

The reclaim is the subtle part. It is a single conditional statement:

```sql
UPDATE idempotency_keys SET status='PENDING', locked_at=now(), updated_at=now()
 WHERE idempotency_key = $key
   AND (status = 'FAILED'
        OR (status = 'PENDING'
            AND (locked_at IS NULL OR locked_at < now() - interval '…' * $lease)))
```

Postgres re-evaluates the `WHERE` **under the row lock**, so two simultaneous
reclaimers serialise and only one can win. No application lock, no advisory lock,
no distributed lock. Default lease: `IDEMPOTENCY_LEASE_MS = 300000` (5 min).

> **The footgun this code exists to avoid.** The result is read as
> `UpdateResult.affected`, never as the length of the `RETURNING` array. TypeORM's
> raw `query()` returns a flat rows array for `INSERT … RETURNING` but a
> `[rows, affectedCount]` **2-tuple** for `UPDATE … RETURNING` — so a
> `.length > 0` check there is *always* truthy. That bug shipped once during
> development and handed `NEW` to every concurrent caller; only a real concurrent
> test against a real database caught it. See the comment at
> [idempotency.service.ts:85-88](../src/idempotency/idempotency.service.ts:85).

### 5.3 AI failure — degrade, then upgrade

The enricher **never throws** ([ai.enricher.ts:47-73](../src/enrichment/ai.enricher.ts:47)).
Availability never depends on the model; only *quality* does.

**Failure classification.** Every failure mode collapses to one type,
`TransientEnrichmentError` ([mistral.client.ts:68-79](../src/enrichment/mistral.client.ts:68)):
network error, non-2xx, `AbortController` timeout (`MISTRAL_TIMEOUT_MS`, 10s),
empty content, non-JSON content, and **schema-invalid content**. JSON mode
guarantees valid JSON, not *correct* JSON, so every response is zod-validated
([llm-response.schema.ts](../src/enrichment/llm-response.schema.ts)) — enum
values are upper-cased first so trivial casing doesn't cause a needless retry,
but an unknown category fails rather than being silently coerced.

**Resilience order** — retry loop *wraps* the breaker:
1. Not configured (no API key) or breaker already open → degrade immediately, no
   call attempted ([ai.enricher.ts:49-54](../src/enrichment/ai.enricher.ts:49)).
2. `callWithRetry`: up to `MISTRAL_MAX_RETRIES + 1` attempts (default 3), backoff
   base 500ms capped 5000ms. **Bails out early if the breaker opened mid-loop** —
   retrying would only spin on fast-failing calls
   ([ai.enricher.ts:85](../src/enrichment/ai.enricher.ts:85)).
3. opossum breaker: opens at `errorThresholdPercentage` (50%) once
   `volumeThreshold` (5) calls have been seen; after `resetTimeout` (30s) goes
   half-open and lets one probe through; success closes, failure re-opens. Every
   transition is pushed to a gauge — `0` closed, `0.5` half-open, `1` open
   ([mistral.circuit-breaker.ts:48-59](../src/enrichment/mistral.circuit-breaker.ts:48)).
4. On any failure → `FallbackClassifier`: deterministic keyword matching that
   returns the **same shape** as the AI path, with `confidence: 0.3` as the
   explicit "this is degraded" signal
   ([fallback.classifier.ts:33-41](../src/enrichment/fallback.classifier.ts:33)).

**Side effects are keyed off the prior status**, not the new one
([ticket.processor.ts:133-152](../src/pipeline/ticket.processor.ts:133)):

| prior → outcome | Event emitted |
| --- | --- |
| `PENDING` → anything | `ticket.triaged` |
| `DEGRADED` → `ENRICHED` | `ticket.enrichment_upgraded` (a genuinely new fact) |
| `DEGRADED` → `DEGRADED` | nothing — `triaged` already fired |
| `ENRICHED` → anything | nothing — idempotent reprocess |

The two events carry **distinct** `dedup_key`s, so an upgrade is never absorbed
as a duplicate of the original triage.

**The upgrade chain.** A `DEGRADED` outcome schedules a *delayed* re-enrichment
([ticket.processor.ts:156-173](../src/pipeline/ticket.processor.ts:156)) with
`jobId = <key>:upgrade:<attempt>` and jittered delay
(`ENRICHMENT_UPGRADE_BACKOFF_MS`, 30s base), capped at
`ENRICHMENT_UPGRADE_MAX_ATTEMPTS` (5). The delay is deliberately **decoupled from
breaker state**: each degraded ticket recovers on its own staggered schedule
rather than all of them stampeding the moment the breaker closes.

**The last gap: reconciliation.** If the upgrade job itself is lost — Redis
flushed, crash before enqueue, attempts exhausted — the ticket would sit
`DEGRADED` forever. The sweeper treats Postgres as the source of truth
([reconcile.sweeper.ts:68-85](../src/pipeline/reconcile.sweeper.ts:68)):

```sql
SELECT t.id, t.event_id, e.idempotency_key
  FROM tickets t JOIN events e ON e.id = t.event_id
 WHERE t.enrichment_status = 'DEGRADED'
   AND t.updated_at < now() - interval '…' * $RECONCILE_DEGRADED_AFTER_MS
 ORDER BY t.updated_at ASC LIMIT $RECONCILE_BATCH_SIZE
```

Re-enqueued through the **original idempotency key** with
`jobId = <key>:reconcile:0`, bounded by interval + batch size so a post-outage
backlog drains steadily.

### 5.4 Failure → DLQ → replay

1. Job throws. BullMQ retries per `attempts` (default 5) using the custom
   exponential+jitter strategy ([pipeline.backoff.ts](../src/pipeline/pipeline.backoff.ts),
   which reads env lazily so tests can retune it).
2. The `failed` handler fires on **every** attempt and must decide whether the
   failure is *terminal* ([ticket.processor.ts:184-259](../src/pipeline/ticket.processor.ts:184)).
   See §11 — this is subtler than it looks.
3. Terminal ⇒ `recordDeadLetter`: queue name, job id, idempotency key, the
   **verbatim job payload**, error message, full stack, attempts, `failed_at`
   ([dlq.service.ts:41-68](../src/pipeline/dlq/dlq.service.ts:41)). The payload
   is the source of truth for replay.
4. `POST /dlq/:id/replay` flips `PENDING → REPLAYED` with a conditional
   `UPDATE … RETURNING` **before** enqueueing, so two concurrent replays cannot
   both fire; if the enqueue then throws, the flip is reverted so an operator can
   retry ([dlq.service.ts:99-138](../src/pipeline/dlq/dlq.service.ts:99)).
   Double replay → **409**.
5. The replayed job uses `jobId = <key>:replay:<deadLetterId>` — a *fresh* id, so
   it actually runs (reusing the original key would be suppressed as a duplicate
   add). Correctness still holds because the **work** keys off
   `data.idempotencyKey`: the ticket already exists and is reused, and the outbox
   `dedup_key` absorbs the side effect. **A replay cannot duplicate a ticket or a
   notification** — the DLQ ⇄ idempotency intersection, and the sharpest thing in
   the repo to poke at in review.

---

## 6. Resilience mechanisms in depth

**Idempotency ledger.** Covered above. The design claim is that *all* concurrency
safety lives in the database: one `UNIQUE` constraint, one `ON CONFLICT DO
NOTHING`, one conditional `UPDATE`, one `FOR UPDATE`. No application locks means
nothing to leak, nothing to expire incorrectly, and correct behaviour across any
number of replicas for free.

**Transactional outbox.** `OutboxService.emit` takes an `EntityManager` — the
caller's transaction — and there is deliberately **no** "emit outside a
transaction" method ([outbox.service.ts:17-23](../src/outbox/outbox.service.ts:17)).
The API makes the pattern unbypassable. `dedup_key` is
`aggregateType:aggregateId:eventType:version`, deterministic so a reprocess lands
on the same key and is absorbed by `ON CONFLICT DO NOTHING`, and versioned so two
genuinely distinct effects can never collide and silently drop one.

**Relay.** `FOR UPDATE SKIP LOCKED` lets N relay instances poll the same table
with zero coordination — the second instance steps over locked rows instead of
blocking. Delivery is at-least-once *by construction*: the HTTP dispatch happens
inside the transaction that marks the row `SENT`, so a crash between the call and
the commit rolls back and redelivers. The consumer deduplicates. The relay also
self-tunes: a full batch schedules the next drain immediately, otherwise it waits
`OUTBOX_RELAY_POLL_INTERVAL_MS` ([outbox.relay.ts:101-107](../src/outbox/outbox.relay.ts:101)),
and a `draining` flag prevents overlapping ticks.

Terminal outbox failure is explicit: at `OUTBOX_MAX_ATTEMPTS` (10) the row goes
`FAILED`, drops out of the partial index, and increments
`outbox_messages_failed_total` — *the* metric to alert on, because it means an
at-least-once guarantee was knowingly abandoned
([outbox.relay.ts:173-187](../src/outbox/outbox.relay.ts:173)).

**Backoff.** One helper, three consumers (pipeline retries, outbox redelivery,
in-call Mistral retries). It implements AWS **equal jitter**:
`half = min(maxMs, base·2^(attempt-1)) / 2; delay = half + rand(0, half)` — so
the returned delay lands in `[E/2, E)`, *not* `E + jitter`
([backoff.ts:19-24](../src/common/backoff/backoff.ts:19)).

**Transaction helper.** Every manual transaction funnels through
`runInTransaction`, which owns connect/commit/rollback/**release** exactly once
([transaction.helper.ts:20-38](../src/common/database/transaction.helper.ts:20)).
This exists because forgetting `release()` in a `finally` leaks a pooled
connection on every error path until the pool wedges — a classic TypeORM footgun.
No call site owns that lifecycle.

---

## 7. Observability and operations

**Correlation.** An id is minted (or honoured from an inbound
`x-correlation-id`) by middleware registered on the raw adapter in
[main.ts:25-31](../src/main.ts:25) — before pino-http and every route handler —
and echoed back on the response. It rides in `AsyncLocalStorage`, so the Pino
mixin stamps it on every log line without threading it through signatures.
**ALS does not cross Redis**, so the id is copied into the job payload at enqueue
and re-established in the worker via `runWithCorrelation`
([ticket.processor.ts:68](../src/pipeline/ticket.processor.ts:68)); the relay
re-establishes it again from `payload.correlationId`
([outbox.relay.ts:134-141](../src/outbox/outbox.relay.ts:134)). One id therefore
traces HTTP → queue → worker → LLM call → webhook dispatch.

**Metrics** (`GET /metrics`, private registry + default Node metrics):

| Metric | Type | Labels |
| --- | --- | --- |
| `events_ingested_total` | counter | `result`: accepted \| duplicate \| conflict |
| `events_processed_total` | counter | — |
| `events_failed_total` | counter | `disposition`: retry \| dead_letter \| dead_letter_write_failed |
| `pipeline_queue_depth` | gauge | `state`: waiting \| active \| delayed \| failed |
| `dlq_depth` | gauge | — |
| `enrichment_latency_seconds` | histogram | `source`: ai \| fallback |
| `enrichment_results_total` | counter | `source`, `result` |
| `circuit_breaker_state` | gauge | `breaker` (0 / 0.5 / 1) |
| `outbox_pending` | gauge | — |
| `outbox_messages_dispatched_total` | counter | — |
| `outbox_messages_failed_total` | counter | — |
| `outbox_dispatch_latency_seconds` | histogram | — |

Depth gauges are sampled every 5s by `PipelineObserver`; `outbox_pending` is
refreshed on every relay tick. Together they answer "where is work piling up
unseen?" — the observability half of the central invariant.

**Health.** Two probes, deliberately different
([health.controller.ts](../src/health/health.controller.ts)): `/health`
(liveness) is **dependency-free** so a transient DB blip can't trigger a restart
loop; `/ready` (readiness) pings Postgres and Redis so a struggling instance is
pulled from the load balancer without being killed.

**Config.** One zod schema is the single source of truth
([env.validation.ts](../src/config/env.validation.ts)); invalid config aborts
boot with every offending variable listed at once. Notable defaults:
`PIPELINE_MAX_ATTEMPTS=5`, `IDEMPOTENCY_LEASE_MS=300000`,
`OUTBOX_MAX_ATTEMPTS=10`, `OUTBOX_RELAY_BATCH_SIZE=20`, `MISTRAL_TIMEOUT_MS=10000`,
`MISTRAL_MAX_RETRIES=2`, `CIRCUIT_BREAKER_RESET_MS=30000`,
`RECONCILE_DEGRADED_AFTER_MS=300000`.

**Running it.** `make up` builds and starts app + Postgres + Redis, with the app
gated on both healthchecks. Host-published ports (`POSTGRES_PORT`, `REDIS_PORT`)
are decoupled from in-container ports, so remapping around a busy host port
doesn't break the app. Schema changes go through explicit migrations, never
`synchronize`. CI runs typecheck → build → the full Testcontainers suite on
`ubuntu-latest` (which ships Docker).

---

## 8. Test strategy

The suite is **integration-first over real infrastructure**, and that is a
deliberate reaction to a real incident during development (see §5.2): a logic bug
passed every unit-level check and was caught only by running 12 concurrent
requests against a real Postgres.

- **Postgres and Redis are real**, via Testcontainers — so `SKIP LOCKED`,
  `RETURNING` semantics, row-lock serialisation and genuine concurrency are
  exactly what production runs.
- **Only the Mistral and webhook HTTP boundaries are mocked**, and even then by
  pointing the *real* SDK at a local mock server (`MISTRAL_SERVER_URL`). The
  client, timeout, zod validation, retry loop and breaker all execute for real.
  Nothing internal is stubbed.
- The one internal seam is the `ENRICHER` provider, wrapped by a
  `FaultInjectingEnricher` that delegates to the real `AiEnricher` unless a test
  arms a fault ([harness.ts](../test/utils/harness.ts)).

**14 integration tests** covering: idempotent replay, 409 on key reuse, the
10-way concurrency race, AI classification with exactly one side effect, outbox
retry-until-delivered, degradation on failure, degradation on schema-invalid
output, breaker opening, degrade→upgrade with a *distinct* side effect, DLQ on
exhaustion, replay without duplication, DLQ on early-terminal failures (×2), and
the reconciliation sweep.

`reset()` pauses the worker (waiting for the active job to finish its
transaction) before `TRUNCATE`, or the truncate deadlocks against a job mid-write.

**10 unit tests** (`npm run test:unit`, [test/unit/](../test/unit/)) cover the one
area where integration testing genuinely cannot reach: terminal-failure
classification in the worker's `failed` handler. `job.discard()` and a backoff of
`-1` are never triggered by this codebase, and "Redis wedged mid-probe" cannot be
staged against a healthy Testcontainers Redis — yet those are precisely the
branches where a silent loss would hide. They are exercised against a fake `Job`:
the `isFailed()` backstop, the name-based unrecoverable check, probe rejection,
probe *hang*, an unwritable dead letter, and three "the handler must never
reject" cases. This is the deliberate exception to the integration-first rule,
not a softening of it.

---

## 9. Sharp edges a maintainer must know

1. **TypeORM raw `query()` return shape.** Flat rows for `INSERT … RETURNING`;
   `[rows, affectedCount]` for `UPDATE … RETURNING`. Always use
   `UpdateResult.affected`. This caused a real bug.
2. **BullMQ custom jobId rules.** A custom id may not be all-digits, and may
   contain `:` **only** if it splits into exactly 3 parts (legacy repeatable-job
   compatibility) — verified at
   `node_modules/bullmq/dist/cjs/classes/job.js:1043,1049`. Hence
   `<key>:reconcile:0`, not `<key>:reconcile`. **Corollary: a client-supplied key
   containing a colon breaks every jobId scheme** (see §11).
3. **BullMQ terminal failures do not always increment `attemptsMade`.** A stalled
   job (worker crash / lost lock) has its *stall* counter bumped (`stc`, not
   `atm`) and, past `maxStalledCount`, gets a deferred-failure marker (`defa`)
   that the worker converts into an `UnrecoverableError` **before the processor
   runs** — so it retires permanently with `attemptsMade` of 1 against a budget
   of 5. `job.discard()` and a backoff returning `-1` are terminal the same way.
   `isTerminalFailure` therefore checks the error type (by `instanceof` **and**
   by name — a duplicate `bullmq` copy in the tree defeats `instanceof`) *and*
   attempts *and* falls back to a bounded `job.isFailed()` probe.
   Consequence: **`removeOnFail` must RETAIN the failed job long enough to be
   observed.** `true`, `{ age: 0 }` and `{ count: 0 }` each delete it first and
   silently defeat the backstop; every enqueue path uses `{ age: 86400 }`.
   Because the probe needs Redis — which may be what is broken — it is bounded by
   a 2s timeout, and a classification failure is treated as *terminal*: a
   spurious dead letter is self-correcting (replay is idempotent), a missed one
   is not. Failure to **classify** and failure to **persist** are caught
   separately, so only an unwritable record raises the "job lost" alarm.
4. **`@nestjs/bullmq` attaches event handlers with a bare `worker.on(...)**`
   (`bull.explorer.js:160`), so an async handler that rejects is an *unhandled*
   rejection. `onFailed` is fully wrapped for this reason.
5. **`moveToFailed` increments `attemptsMade` before the `failed` event fires**
   (`job.js:555` vs `worker.js:662-663`) — which is why the ordinary exhaustion
   comparison is `>=`, not `> `.
6. **AsyncLocalStorage does not cross Redis.** Correlation ids must be copied
   into the job payload explicitly.
7. **Mistral SDK response validation** requires `created` (a number) on the mock
   response, or the SDK rejects it before your code sees it.
8. **`jest-e2e.json` sets ts-jest `diagnostics: false`** — the test files are not
   type-checked by the test run, and `npm run typecheck` only covers
   `tsconfig.json`. Typecheck test files separately when changing them.

---

## 10. Limitations

Scope boundaries I chose on purpose, and the things I would build next.

**Idempotency key retention.** `idempotency_keys` grows without bound. Production
wants a reaper for `COMPLETED` rows older than the client's retry window, exposed
as a job and a metric. Noted in ADR-0001 rather than built.

**Relay throughput.** The relay holds the row lock across the HTTP dispatch. That
is correct and simple for a single relay, and wrong once volume is high enough
that a slow downstream ties up rows. The scale version is claim-then-dispatch:
mark the row with a lease, commit, dispatch outside the transaction, then settle
it. ADR-0008 records this as the known next step.

**Leader election for the sweep.** The reconciliation sweep runs on every
instance, so N replicas each scan the same rows. It is safe (the per-ticket job
id collapses duplicates) but wasteful. An advisory lock or a leader guard would
fix it.

**Backpressure and partitioning.** There is no ingress backpressure and no
per-tenant queue partitioning, so one noisy tenant can starve the rest.

**Batched classification.** Model calls are one per ticket. Batching would cut
both cost and latency.

**No operator surface for abandoned notifications.** An outbox row that exhausts
`OUTBOX_MAX_ATTEMPTS` goes terminal and increments
`outbox_messages_failed_total`. That makes it alertable but not actionable: there
is no endpoint to list terminal rows and no way to retry one. Dead letters got a
queryable table and a replay endpoint for exactly this situation, and the outbox
deserves the same treatment.

**A reconcile job that dead-letters blocks its own ticket.** `queue.add` on an
existing job id is a silent no-op, and a failed reconcile job stays in the failed
set for 24 hours. During that window further sweeps of that ticket do nothing,
while `sweep()` still counts it as re-driven. The sweep is the backstop for
stranded tickets, so a backstop that can quietly stop working for one ticket is
worth closing.

**Config coupling in the sweep.** The reconcile job uses a hardcoded
`removeOnComplete: { age: 30 }`. Setting `RECONCILE_SWEEP_INTERVAL_MS` below that
means the previous job still exists when the next sweep runs, and the re-add is
absorbed. The two values should not be independent.

**Ingest-to-enqueue reconciliation.** The enqueue now sits inside the transaction
handler's error path, so a failure marks the key `FAILED` and it can be re-driven.
What does not exist is the ingestion-side equivalent of the DEGRADED sweep: a
periodic check for tickets that are `PENDING` with no live job. The window is
small and self-correcting on retry, but it is the one remaining place where the
database and the queue could disagree without anything noticing.
