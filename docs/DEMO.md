# Walkthrough

What this service does, in the order worth discovering it. Every step below is
a real request you can run against the live deployment.

```bash
./scripts/demo.sh                                       # localhost:3000
./scripts/demo.sh https://triage-engine.youneskaouani.dev
```

The script runs all of it and checks each result, so it doubles as a smoke test.
This page is the same thing written out, with what each step is actually proving.

`BASE=https://triage-engine.youneskaouani.dev` for the commands below.

---

## The one thing to know first

A classification that comes back **`DEGRADED` / `FALLBACK` with confidence 0.3
is not a failure.** It means the model was unavailable — or no API key is
configured on the demo — so a rule-based classifier ran instead and an AI upgrade
was queued for when it recovers. The ticket is still categorised, still
prioritised, and still triggers its notification.

That is the design: the model affects *quality*, never *availability*. If you see
`DEGRADED` on the public demo, you are looking at graceful degradation working,
not something broken.

---

## 1. Submit a ticket

```bash
curl -XPOST $BASE/events \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"subject":"Double charged on invoice","body":"I was billed twice for the Pro plan, please refund","requesterEmail":"alex@example.com"}'
```

```json
{"status":"accepted","idempotencyKey":"demo-1","ticketId":"79e3a8af-…","jobId":"demo-1"}
```

`202`, not `201`. The ticket is stored and queued; the classification has not
happened yet. You get the id immediately.

## 2. Read it back

```bash
curl $BASE/tickets/79e3a8af-…
```

```json
{
  "enrichment": {
    "status": "DEGRADED", "source": "FALLBACK",
    "category": "BILLING", "priority": "MEDIUM",
    "confidence": 0.3, "attempts": 1
  }
}
```

Poll it straight after submitting and you will catch `"status":"PENDING"` before
the worker picks it up. `ENRICHED`/`AI` means the model ran; `DEGRADED`/`FALLBACK`
means the rules did.

## 3. Send the exact same request again

**Proves: at-least-once delivery cannot create duplicates.**

```bash
# identical body, identical key
curl -XPOST $BASE/events -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' -d '{…same…}'
```

```json
{"status":"replayed","ticketId":"79e3a8af-…"}
```

Same id, no second ticket. Upstream systems retry on timeout, so this is the
normal case, not an edge case.

## 4. Reuse the key with a different body

**Proves: a genuine client bug is surfaced, not absorbed.**

```bash
curl -XPOST $BASE/events -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' -d '{"subject":"different","body":"different content"}'
```

```
409  idempotency key was already used with a different payload
```

The key is checked against a hash of the content, so "same key, new body" is
detected rather than guessed at. Silently accepting one of the two payloads would
be worse than refusing.

## 5. Send a key the queue cannot use

**Proves: bad input fails before anything is written.**

```bash
curl -XPOST $BASE/events -H 'Idempotency-Key: order:123' -d '{…}'   # 400
curl -XPOST $BASE/events -H 'Idempotency-Key: 12345'     -d '{…}'   # 400
```

The key becomes a queue job id, and the queue rejects ids containing a colon or
made only of digits. Rejecting at the door beats storing a ticket whose job can
never be enqueued — which is exactly the bug this check was added for.

## 6. Twelve at once

**Proves: the invariant holds under a real race, not just sequential retries.**

```bash
for i in $(seq 1 12); do
  curl -s -XPOST $BASE/events -H 'content-type: application/json' \
    -H 'Idempotency-Key: demo-race' -d '{…}' &
done; wait
```

One response says `accepted`. The rest say `processing` — they arrived while the
winner still held the key, so they are told the work is already in flight rather
than being handed a result that does not exist yet. Exactly one ticket exists
afterwards.

The race is settled by a `UNIQUE` constraint and `INSERT … ON CONFLICT DO NOTHING`
in Postgres. There is no application lock, which is why it stays correct across
any number of instances.

## 7. Check the notification fired

```bash
curl $BASE/_sink/deliveries
```

```json
{"unique":1,"deliveries":[{"dedupKey":"ticket:79e3a8af-…:ticket.triaged:v1","count":1}]}
```

The notification row is written in the *same transaction* as the ticket update,
so a crash between "ticket updated" and "notification queued" is impossible. A
relay then delivers it at-least-once against that dedup key, and the consumer
collapses repeats. One state change, one delivery.

## 8. Look at the operational surface

```bash
curl $BASE/metrics | grep -E 'dlq_depth|outbox_pending|circuit_breaker_state'
curl $BASE/dlq
```

| Signal | Meaning |
| --- | --- |
| `dlq_depth` | jobs that failed permanently and are waiting for a decision |
| `outbox_messages_failed_total` | notifications abandoned after exhausting retries — an at-least-once guarantee knowingly given up |
| `events_failed_total{disposition="dead_letter_write_failed"}` | a job went terminal and its record could not even be written. The worst state reachable |
| `circuit_breaker_state` | `1` = the model is being skipped entirely; everything is degrading to fallback |
| `outbox_pending` climbing | the relay is behind, or the downstream is down |

Every place work can pile up unseen has a gauge; every place the engine gives up
has a counter. That is the whole point of the design being visible from outside.

---

## What you cannot trigger from outside

These need fault injection, so they are proven by the integration suite
(`npm test`) rather than by curl. It runs the whole stack against real Postgres
and Redis and fakes only the outbound HTTP calls.

| Behaviour | Test |
| --- | --- |
| Model fails → ticket degrades to the rule-based classifier | `degrades to the fallback (not lost) when Mistral fails` |
| Model returns valid JSON of the wrong shape → treated as a failure | `treats a malformed (schema-invalid) response as a failure and degrades` |
| Repeated failures open the circuit breaker | `opens the circuit breaker after repeated failures` |
| Model recovers → degraded ticket upgrades, with a *distinct* notification | `upgrades a degraded ticket to AI on recovery, with a DISTINCT side effect` |
| Downstream returns 500s → relay retries until delivered | `retries dispatch until the side effect is delivered` |
| Job exhausts retries → dead letter with full context | `dead-letters a job that exhausts its retries, with error context` |
| Job retired early by the queue (stall, unrecoverable) still dead-letters | `dead-letters an UnrecoverableError even though attempts remain`, `…after it stalled` |
| Replay re-enters through the original key and duplicates nothing | `replay re-enters through the same key without duplicating the ticket` |
| Upgrade job lost entirely → sweep re-drives the ticket | `re-drives a ticket whose upgrade job was lost` |

If you want to watch degradation live, run the stack locally with
`MISTRAL_API_KEY` unset: every ticket takes the fallback path.
