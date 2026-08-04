import { Controller, Get, Headers, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { join } from 'node:path';
import { SKIP_ALL } from '../common/rate-limit/rate-limit.module';

/**
 * Resolved from the working directory rather than `__dirname`, which differs
 * between `dist/landing` in the image and `src/landing` under ts-node.
 */
const INDEX_HTML = join(process.cwd(), 'public', 'index.html');

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
  index(@Headers('accept') accept: string | undefined, @Res() res: Response) {
    // A browser gets the interactive demo; curl gets a machine-readable index of
    // the routes. Static assets are mounted with `index: false` precisely so
    // this negotiation still happens.
    if (accept?.includes('text/html')) {
      return res.sendFile(INDEX_HTML);
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
  demo: 'Open this URL in a browser for an interactive walkthrough.',
  tryIt:
    'curl -XPOST $BASE/events -H \'content-type: application/json\' -H \'Idempotency-Key: demo-1\' -d \'{"subject":"Double charged","body":"Billed twice for the Pro plan, please refund"}\'',
  note: 'A classification of DEGRADED with source FALLBACK is not an error. It means the model was unavailable, so a rule-based classifier ran instead and an AI upgrade was queued. The ticket is never dropped because the model is down.',
};
