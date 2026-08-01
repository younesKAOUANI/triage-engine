# ADR-0003: Circuit breaker — opossum over a hand-rolled one

Status: Accepted

## Context

Every Mistral call needs a circuit breaker: after a run of failures we should stop
hammering a dependency that is clearly down, fail fast to the fallback, and probe
periodically for recovery. The breaker needs the full state machine (closed →
open → half-open → closed), a rolling-window failure metric, a volume threshold so
one early blip doesn't trip it, a timeout, and events we can hook for metrics.

We could implement this by hand. It is not conceptually hard, but the half-open
probe accounting, the rolling window, and the edge cases (a failure during the
half-open probe, concurrent calls while transitioning) are exactly where a
hand-rolled version quietly gets it wrong.

## Decision

Use **opossum**, the de-facto Node circuit-breaker library.

- The breaker wraps a single Mistral call. Config maps straight onto env:
  `errorThresholdPercentage`, `volumeThreshold`, `timeout`, `resetTimeout`.
- opossum's `timeout` is a backstop above the client's own AbortController timeout,
  so the underlying HTTP is actually aborted while the breaker still reacts even if
  a call hangs in a way the abort misses.
- Its `open` / `halfOpen` / `close` events drive the `circuit_breaker_state` gauge
  (1 / 0.5 / 0), so the breaker is observable, not a black box.

Writing my own would mean reimplementing the half-open probe accounting and the
rolling error window, both easy to get subtly wrong and tedious to test properly.
opossum already does it, and the interesting work on this project is elsewhere.

## Consequences

- **Positive**: a correct, battle-tested state machine with minimal code; clean
  config and observability hooks. Verified live: repeated mock failures opened the
  breaker, it half-opened and probed after `resetTimeout`, and closed on recovery,
  with each transition reflected in the gauge.
- **Negative / accepted**:
  - A third-party dependency and its types (`@types/opossum`).
  - opossum is per-process, so each app instance has its own breaker. That is
    acceptable (and arguably desirable — a node with a bad network path can degrade
    independently); a shared/distributed breaker would need external state and is
    out of scope.
  - Retry interaction is deliberate: the retry loop wraps `breaker.fire()` and
    bails out the moment the breaker is open, rather than spinning on fast-failing
    calls (see ADR-0005).
