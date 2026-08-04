import { Controller, Get, Header, Headers, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SKIP_ALL } from '../common/rate-limit/rate-limit.module';

/**
 * The front door.
 *
 * Without this, `GET /` returns `Cannot GET /` and a visitor has no way to tell
 * what the service is, what it guarantees, or which endpoints exist. Everything
 * interesting here is a POST or a side effect, so the system has to introduce
 * itself.
 *
 * Content-negotiated: a browser gets a readable page, curl gets a JSON index of
 * the routes. No assets, no build step, no framework — one self-contained
 * response, because a landing page that can break the deployment is not worth
 * having.
 */
@SkipThrottle(SKIP_ALL)
@Controller()
export class LandingController {
  @Get()
  @Header('cache-control', 'public, max-age=60')
  index(@Headers('accept') accept: string | undefined, @Res() res: Response) {
    if (accept?.includes('text/html')) {
      return res.type('html').send(PAGE);
    }
    return res.json(INDEX);
  }
}

const INDEX = {
  service: 'triage-engine',
  summary:
    'Ingests support tickets, classifies them with an LLM, and notifies a downstream system. Built so that nothing is ever silently lost.',
  source: 'https://github.com/younesKAOUANI/triage-engine',
  endpoints: {
    'POST /events':
      'Submit a ticket. 202 accepted|processing|replayed, 409 on key reuse with a different body, 400 on an unusable key. Send an Idempotency-Key header.',
    'GET /tickets/:id': 'Ticket with its classification and status.',
    'GET /dlq': 'Jobs that failed permanently. ?status=PENDING to filter.',
    'POST /dlq/:id/replay':
      'Replay one through its original idempotency key. Cannot duplicate a ticket.',
    'GET /metrics': 'Prometheus exposition.',
    'GET /health': 'Liveness. Checks nothing on purpose.',
    'GET /ready': 'Readiness. Checks Postgres and Redis.',
  },
  tryIt:
    'curl -XPOST $BASE/events -H \'content-type: application/json\' -H \'Idempotency-Key: demo-1\' -d \'{"subject":"Double charged","body":"Billed twice for the Pro plan, please refund"}\'',
  note: 'A classification of DEGRADED with source FALLBACK is not an error. It means the model was unavailable, so a rule-based classifier ran instead and an AI upgrade was queued. The ticket is never dropped because the model is down.',
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>triage-engine</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#666; --line:#e3e3e3; --acc:#0b5fff; --bg:#fff; --code:#f6f6f7; }
  @media (prefers-color-scheme:dark){ :root{ --fg:#e8e8e8; --dim:#999; --line:#2a2a2a; --acc:#6ea8ff; --bg:#131315; --code:#1c1c1f; } }
  * { box-sizing:border-box }
  body { margin:0 auto; padding:3rem 1.25rem 5rem; max-width:46rem; background:var(--bg); color:var(--fg);
         font:16px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }
  h1 { font-size:1.6rem; margin:0 0 .3rem }
  h2 { font-size:1rem; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
       margin:2.75rem 0 .9rem; font-weight:600 }
  p { margin:0 0 1rem } a { color:var(--acc) }
  .sub { color:var(--dim); margin-bottom:2rem }
  code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86rem }
  pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:.9rem 1rem;
        overflow-x:auto; margin:0 0 1rem }
  table { border-collapse:collapse; width:100%; font-size:.92rem }
  td { border-top:1px solid var(--line); padding:.6rem .5rem .6rem 0; vertical-align:top }
  td:first-child { white-space:nowrap; padding-right:1.25rem; font-family:ui-monospace,monospace; font-size:.84rem }
  .note { border-left:3px solid var(--acc); padding:.1rem 0 .1rem 1rem; color:var(--dim); margin:1rem 0 }
  footer { margin-top:3.5rem; padding-top:1.25rem; border-top:1px solid var(--line); color:var(--dim); font-size:.88rem }
</style>

<h1>triage-engine</h1>
<p class="sub">Support tickets in, classified tickets and notifications out — without
losing anything on the way.</p>

<p>Submit a ticket and the service stores it, queues it, classifies it with an LLM, and
notifies a downstream system. The classification is the small part. Most of this exists to
survive duplicate deliveries, worker crashes, a downstream returning 500s, and a model that
is sometimes slow, wrong-shaped, or down.</p>

<h2>Try it</h2>
<pre>curl -XPOST https://triage-engine.youneskaouani.dev/events \\
  -H 'content-type: application/json' \\
  -H 'Idempotency-Key: my-first-ticket' \\
  -d '{"subject":"Double charged","body":"Billed twice for the Pro plan, please refund"}'</pre>
<p>You get a <code>ticketId</code> back straight away. Read it:</p>
<pre>curl https://triage-engine.youneskaouani.dev/tickets/&lt;id&gt;</pre>
<p>Now send the <em>exact same request again</em>. You get <code>"status":"replayed"</code>
and the same id — not a second ticket. Change the body but keep the key and you get a
<code>409</code>, because that is a client bug rather than a retry.</p>

<div class="note"><strong>DEGRADED is not an error.</strong> If the classification comes back
<code>DEGRADED</code> / <code>FALLBACK</code> with confidence 0.3, the model was unavailable,
so a rule-based classifier ran instead and an AI upgrade was queued for when it recovers.
A ticket is never dropped because the model is down.</div>

<h2>Endpoints</h2>
<table>
<tr><td>POST /events</td><td>Submit a ticket. <code>202</code> accepted / processing / replayed,
  <code>409</code> on key reuse with a different body, <code>400</code> on a key that cannot
  become a job id. Rate limited per IP.</td></tr>
<tr><td>GET /tickets/:id</td><td>A ticket with its classification and status.</td></tr>
<tr><td>GET /dlq</td><td>Jobs that failed permanently, with the error and the original payload.</td></tr>
<tr><td>POST /dlq/:id/replay</td><td>Replay one through its original idempotency key, so it
  cannot duplicate a ticket or a notification.</td></tr>
<tr><td>GET /metrics</td><td>Prometheus exposition: ingestion outcomes, queue and DLQ depth,
  circuit-breaker state, abandoned notifications.</td></tr>
<tr><td>GET /health</td><td>Liveness. Checks nothing on purpose — a database blip should not
  cause a restart loop.</td></tr>
<tr><td>GET /ready</td><td>Readiness. Checks Postgres and Redis.</td></tr>
</table>

<h2>What it guarantees</h2>
<table>
<tr><td>no duplicates</td><td>One ticket per idempotency key, even under a dozen simultaneous
  identical requests. The race is settled by a unique constraint in Postgres, not an
  application lock.</td></tr>
<tr><td>no lost notifications</td><td>The notification is written in the same transaction as
  the ticket update, then delivered at-least-once against a dedup key. A crash between the
  two is impossible by construction.</td></tr>
<tr><td>no lost failures</td><td>A job that exhausts its retries lands in a queryable table
  with its full error and payload, and can be replayed.</td></tr>
<tr><td>no lost tickets</td><td>If the model is down the ticket is classified by rules and
  queued for an upgrade. If that upgrade job is ever lost, a reconciliation sweep re-drives
  it from the database.</td></tr>
</table>

<footer>
  <a href="https://github.com/younesKAOUANI/triage-engine">Source, architecture notes and nine
  ADRs on GitHub</a> · <a href="/health">health</a> · <a href="/ready">ready</a> ·
  <a href="/metrics">metrics</a> · <a href="/dlq">dlq</a>
  <p style="margin-top:.8rem">Run <code>scripts/demo.sh</code> from the repository to walk
  every behaviour above against this deployment.</p>
</footer>
`;
