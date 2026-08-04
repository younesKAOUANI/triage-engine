#!/usr/bin/env bash
#
# Guided walkthrough of the triage engine.
#
#   ./scripts/demo.sh                                    # against localhost:3000
#   ./scripts/demo.sh https://triage-engine.youneskaouani.dev
#
# Each scenario states what it is meant to prove, shows the request, and checks
# the response. Exits non-zero if any check fails, so it doubles as a smoke test
# against a live deployment.
#
# Needs: curl, python3.
set -uo pipefail

BASE="${1:-http://localhost:3000}"
RUN="demo-$(date +%s)"   # unique prefix so re-runs don't collide on old keys
PASS=0
FAIL=0

c_head=$'\033[1;36m'; c_ok=$'\033[0;32m'; c_bad=$'\033[0;31m'; c_dim=$'\033[0;90m'; c_off=$'\033[0m'

scenario() { printf '\n%s─── %s ───%s\n' "$c_head" "$1" "$c_off"; }
explain()  { printf '%s%s%s\n' "$c_dim" "$1" "$c_off"; }
show()     { printf '%s$ %s%s\n' "$c_dim" "$1" "$c_off"; }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '%s  PASS%s %s (%s)\n' "$c_ok" "$c_off" "$1" "$3"; PASS=$((PASS+1))
  else
    printf '%s  FAIL%s %s — expected %s, got %s\n' "$c_bad" "$c_off" "$1" "$2" "$3"; FAIL=$((FAIL+1))
  fi
}
jsonf() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

TICKET='{"subject":"Double charged on invoice","body":"I was billed twice for the Pro plan this month, please refund the duplicate","requesterEmail":"alex@example.com"}'
JSON='content-type: application/json'

printf '%sTriage engine walkthrough%s  →  %s\n' "$c_head" "$c_off" "$BASE"

# ──────────────────────────────────────────────────────────────────────────────
scenario "1. Is it up?"
explain "Two probes, deliberately different. /health is liveness and checks nothing,
so a database blip cannot cause a restart loop. /ready checks Postgres and Redis
and is what the proxy routes on."
show "curl $BASE/health ; curl $BASE/ready"
check "liveness"  200 "$(status_of "$BASE/health")"
check "readiness" 200 "$(status_of "$BASE/ready")"

# ──────────────────────────────────────────────────────────────────────────────
scenario "2. Submit a ticket"
explain "Returns 202, not 201: the work is queued, not done. You get a ticket id
back immediately and the classification lands a moment later."
show "curl -XPOST $BASE/events -H 'Idempotency-Key: $RUN-a' -d '<ticket>'"
RESP=$(curl -s -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: $RUN-a" -d "$TICKET")
echo "  $RESP"
ID=$(echo "$RESP" | jsonf ticketId)
check "accepted" "accepted" "$(echo "$RESP" | jsonf status)"

# ──────────────────────────────────────────────────────────────────────────────
scenario "3. Watch it get classified"
explain "Poll the ticket until enrichment finishes. Two possible good outcomes:
  ENRICHED / AI       the model classified it
  DEGRADED / FALLBACK the model was unavailable or no API key is configured, so a
                      rule-based classifier ran instead and an AI upgrade was
                      queued for later. Confidence 0.3 marks it as degraded.
DEGRADED is NOT a failure. It is the system refusing to drop a ticket just
because the model is down."
show "curl $BASE/tickets/$ID"
STATUS=""; SOURCE=""
for _ in $(seq 1 30); do
  T=$(curl -s "$BASE/tickets/$ID")
  STATUS=$(echo "$T" | python3 -c "import sys,json;print(json.load(sys.stdin)['enrichment']['status'])" 2>/dev/null)
  [ "$STATUS" != "PENDING" ] && [ -n "$STATUS" ] && break
  sleep 1
done
SOURCE=$(echo "$T" | python3 -c "import sys,json;print(json.load(sys.stdin)['enrichment']['source'])" 2>/dev/null)
CATEGORY=$(echo "$T" | python3 -c "import sys,json;print(json.load(sys.stdin)['enrichment']['category'])" 2>/dev/null)
echo "  status=$STATUS source=$SOURCE category=$CATEGORY"
if [ "$STATUS" = "ENRICHED" ] || [ "$STATUS" = "DEGRADED" ]; then
  check "classified" "$STATUS" "$STATUS"
else
  check "classified" "ENRICHED|DEGRADED" "${STATUS:-none}"
fi
check "categorised" "BILLING" "$CATEGORY"

# ──────────────────────────────────────────────────────────────────────────────
scenario "4. Send the exact same request again"
explain "At-least-once delivery means upstream systems resend. The second call
must not create a second ticket. It replays the original response instead."
show "curl -XPOST $BASE/events -H 'Idempotency-Key: $RUN-a' -d '<same ticket>'"
RESP2=$(curl -s -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: $RUN-a" -d "$TICKET")
echo "  $RESP2"
check "replayed"         "replayed" "$(echo "$RESP2" | jsonf status)"
check "same ticket id"   "$ID"      "$(echo "$RESP2" | jsonf ticketId)"

# ──────────────────────────────────────────────────────────────────────────────
scenario "5. Reuse the key with a DIFFERENT body"
explain "That is a client bug, not a retry. Surfacing it as 409 beats silently
accepting one of the two payloads. The key is matched against a hash of the
content, so this is detected rather than guessed at."
show "curl -XPOST $BASE/events -H 'Idempotency-Key: $RUN-a' -d '<different body>'"
check "conflict" 409 "$(status_of -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: $RUN-a" -d '{"subject":"different","body":"a completely different message body"}')"

# ──────────────────────────────────────────────────────────────────────────────
scenario "6. Send an unusable idempotency key"
explain "The key becomes a queue job id, and the queue rejects ids containing a
colon or made only of digits. Rejected at the door with 400, before anything is
written — the alternative is a stored ticket whose job can never be enqueued."
show "curl -XPOST $BASE/events -H 'Idempotency-Key: order:123' -d '<ticket>'"
check "colon rejected"  400 "$(status_of -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: order:123" -d "$TICKET")"
check "digits rejected" 400 "$(status_of -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: 12345"     -d "$TICKET")"

# ──────────────────────────────────────────────────────────────────────────────
scenario "7. Twelve identical requests, all at once"
explain "The interesting case: not a retry after a response, but a genuine race.
Exactly one caller wins the insert. The rest are told the work is already in
flight. One ticket exists at the end — settled by a UNIQUE constraint and an
ON CONFLICT DO NOTHING in Postgres, not by an application lock."
show "12 parallel POSTs with the same Idempotency-Key"
RACE_KEY="$RUN-race"
TMP=$(mktemp -d)
for i in $(seq 1 12); do
  ( curl -s -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: $RACE_KEY" -d "$TICKET" > "$TMP/$i" ) &
done
wait
ACCEPTED=$(grep -l '"accepted"' "$TMP"/* 2>/dev/null | wc -l | tr -d ' ')
# Responses carry no trailing newline, so they concatenate onto one line;
# match on the field rather than trying to split records.
IDS=$(cat "$TMP"/* | grep -o '"ticketId":"[^"]*"' | sort -u | grep -cv 'null' || echo 0)
echo "  responses saying 'accepted': $ACCEPTED   distinct ticket ids returned: $IDS"
check "exactly one winner" 1 "$ACCEPTED"
rm -rf "$TMP"

# ──────────────────────────────────────────────────────────────────────────────
scenario "8. The notification fired exactly once"
explain "The notification row is written in the same transaction as the ticket
update, then a relay delivers it at-least-once against a dedup key. The bundled
consumer collapses repeats, so one state change produces one delivery even if the
relay retries."
show "curl $BASE/_sink/deliveries"
# The relay polls on an interval, so the delivery lands slightly after the
# ticket is updated. Poll rather than reading once, or a slow relay looks
# indistinguishable from a sink that isn't exposed.
DELIV=""; FOUND=""
for _ in $(seq 1 15); do
  DELIV=$(curl -s "$BASE/_sink/deliveries")
  echo "$DELIV" | grep -q "$ID" && { FOUND=yes; break; }
  echo "$DELIV" | grep -q '"deliveries"' || { FOUND=unavailable; break; }
  sleep 1
done
if [ "$FOUND" = "yes" ]; then
  COUNT=$(echo "$DELIV" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(next((x['count'] for x in d.get('deliveries',[]) if '$ID' in x['dedupKey']), 0))
" 2>/dev/null)
  check "delivered exactly once" 1 "$COUNT"
elif [ "$FOUND" = "unavailable" ]; then
  echo "  (the bundled sink is not exposed on this deployment — skipped)"
else
  check "delivered exactly once" 1 "0 (no delivery after 15s)"
fi

# ──────────────────────────────────────────────────────────────────────────────
scenario "9. Rate limiting"
explain "The write endpoint is public, so it is capped per client IP. Probes and
the relay's own delivery target are exempt: a throttled health check reads as an
outage, and a throttled sink would throttle the engine's own notifications."
show "30 rapid POSTs, then a health check"
CODES=""
for i in $(seq 1 30); do
  CODES="$CODES $(status_of -XPOST "$BASE/events" -H "$JSON" -H "Idempotency-Key: $RUN-rl-$i" -d "$TICKET")"
done
LIMITED=$(echo "$CODES" | tr ' ' '\n' | grep -c '^429$' || true)
echo "  429s: $LIMITED / 30"
if [ "$LIMITED" -gt 0 ]; then
  check "limit engages" "yes" "yes"
else
  echo "  (no limit hit — RATE_LIMIT_WRITES may be higher than 30 here)"
fi
check "probe still served" 200 "$(status_of "$BASE/health")"

# ──────────────────────────────────────────────────────────────────────────────
scenario "10. What the operator sees"
explain "Every place work can pile up unseen has a gauge, and every place the
engine gives up has a counter. dlq_depth is jobs that failed permanently;
outbox_messages_failed_total is notifications abandoned after exhausting retries.
Those two are the ones worth alerting on."
show "curl $BASE/metrics | grep -E 'dlq_depth|outbox_pending|circuit_breaker_state'"
curl -s "$BASE/metrics" | grep -E '^(dlq_depth|outbox_pending|circuit_breaker_state|events_ingested_total)' | sed 's/^/  /' | head -8
check "metrics served" 200 "$(status_of "$BASE/metrics")"
check "dead letters listed" 200 "$(status_of "$BASE/dlq")"

# ──────────────────────────────────────────────────────────────────────────────
printf '\n%s─── result ───%s\n' "$c_head" "$c_off"
printf '  %s%d passed%s   %s%d failed%s\n' "$c_ok" "$PASS" "$c_off" \
  "$([ "$FAIL" -gt 0 ] && echo "$c_bad" || echo "$c_dim")" "$FAIL" "$c_off"
cat <<EOF

Not reachable from outside, because they need fault injection:
  - a failing model degrading a ticket, then upgrading it when it recovers
  - a job exhausting retries into the dead-letter table, and being replayed
  - the outbox retrying a downstream that returns 500s
  - the sweep rescuing a ticket whose upgrade job was lost
Those are covered by the integration suite (npm test), which runs the whole
stack against real Postgres and Redis and fakes only the outbound HTTP calls.
EOF
[ "$FAIL" -eq 0 ]
