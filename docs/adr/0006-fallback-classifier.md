# ADR-0006: A rule-based fallback classifier

Status: Accepted

## Context

Graceful degradation (ADR-0005) requires *something* to classify a ticket when the
AI is unavailable. The options are: (a) leave the ticket unclassified and retry
only, (b) return a fixed default, or (c) a cheap deterministic classifier. Option
(a) means a degraded ticket carries no useful triage at all until the AI recovers;
(b) is barely better. Neither honours "the ticket is usable now".

## Decision

Provide a small **rule-based keyword classifier** that returns the **exact same
shape** as the AI path (`LlmEnrichment`: category, priority, summary, confidence).

- It is deterministic, dependency-free, and instant — safe to run on every
  degradation with no failure modes of its own.
- Returning the same shape is the crucial property: a fallback result is a true
  drop-in for an AI result, so the rest of the pipeline (persist, side effect,
  GET /tickets) is identical whether the classification came from the model or the
  rules. The only differences a consumer sees are `enrichment_source = FALLBACK`
  and a low `confidence` (0.3) — an honest signal that this is degraded output.
- It is intentionally simple (keyword → category, urgency keywords → priority). Its
  job is to keep tickets triaged during an outage, not to rival the model. The AI
  upgrade path (ADR-0005) replaces it with the real classification later.

## Consequences

- **Positive**: every ticket has a usable, consistently-shaped classification at
  all times; downstream code never special-cases "degraded". Cheap to build and to
  run; trivially unit-testable as a pure function.
- **Negative / accepted**:
  - Keyword matching is coarse and English-only; it will misclassify nuanced
    tickets. That is acceptable for a *degraded* path whose results are marked
    low-confidence and are scheduled to be upgraded by the AI. It is explicitly not
    meant to be good enough to make the AI optional.
