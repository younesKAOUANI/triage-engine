# ADR-0005: AI failure handling & graceful degradation

Status: Accepted

## Context

The LLM is the least reliable component in the pipeline: it can be slow, rate-
limited, down, or return a well-formed-but-wrong-shaped response. The project's
governing principle is "nothing is ever silently lost", so a ticket must never be
dropped or stuck because the model misbehaved. At the same time we must not trust
model output blindly.

## Decision

Layered resilience around the call, plus a degrade-now / upgrade-later contract.

**Per-call hardening** (`MistralClient`):
- A hard timeout via AbortController on every call (the breaker's timeout is a
  backstop above it).
- The response is parsed and **zod-validated** against our schema. JSON mode
  guarantees valid JSON, not correct content.
- **Every** failure mode — network error, timeout, non-2xx, non-JSON, and schema
  validation failure — is surfaced as a single `TransientEnrichmentError`. Treating
  a bad/garbage response as transient is deliberate: a retry may succeed, and a
  model consistently returning garbage will trip the breaker and we degrade, rather
  than persisting bad data.

**Resilience composition** (`AiEnricher`):
- A retry loop (exponential backoff + jitter, shared util) wraps the breaker
  (ADR-0003). It bails out immediately if the breaker is open — no spinning on
  fast-failing calls — and otherwise retries transient errors up to a cap.
- The enricher **never throws**: any unrecoverable failure returns a
  `{ DEGRADED, FALLBACK }` outcome from the rule-based classifier (ADR-0006). The
  ticket gets a usable classification *now*.

**Degrade-now / upgrade-later** (the two decisions called out in review):

1. **The upgrade is a distinct event, not a re-fire.** When a DEGRADED ticket is
   later re-enriched by the AI, that is a *legitimate second state change* on the
   aggregate, so it emits a **different** outbox event — `ticket.enrichment_upgraded`
   — separate from the original `ticket.triaged`. Because the outbox `dedup_key`
   includes the event type, the two never collide. The failure mode we explicitly
   avoid: the upgrade's side effect being swallowed because its dedup_key collided
   with the original triage emission. (Verified live: a degraded-then-upgraded
   ticket produced two distinct outbox rows, both delivered exactly once.)

2. **Re-enrichment is a delayed re-queue, decoupled from breaker state.** A DEGRADED
   ticket schedules a BullMQ **delayed** job (backoff + jitter) to retry the AI
   later, capped at `ENRICHMENT_UPGRADE_MAX_ATTEMPTS`. We deliberately do **not**
   drive the upgrade off the breaker's `close` transition. Coupling re-enrichment
   to breaker recovery would stampede: a breaker flapping closed could re-enqueue
   every degraded ticket at once (a thundering herd on the very dependency that
   just recovered). Per-ticket jittered delays spread that load out naturally.

## Consequences

- **Positive**: the AI being down degrades quality, never availability. Tickets are
  always classified and always eventually upgraded when the model returns. Recovery
  is smooth, not a stampede. All of this verified live against a mock Mistral HTTP
  boundary (failure → DEGRADED, recovery → upgrade, breaker open/half-open/close).
- **Negative / accepted**:
  - Upgrade attempts are capped; a ticket can remain permanently DEGRADED if the AI
    is down longer than the cap allows. It is **not lost** — it keeps its fallback
    classification — and the reconciliation sweep (ADR-0009) re-drives it, so it is
    retried again once the AI recovers.
  - There is a tiny window between the state-change commit and the upgrade
    re-enqueue; a crash there leaves a DEGRADED ticket without a scheduled upgrade.
    Acceptable (the ticket is usable), and recovered by the sweep (ADR-0009).
