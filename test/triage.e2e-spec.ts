import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PipelineProducer } from '../src/pipeline/pipeline.producer';
import { ReconcileSweeper } from '../src/pipeline/reconcile.sweeper';
import { Harness, startHarness, waitFor } from './utils/harness';

/**
 * Integration tests over real Postgres + Redis (Testcontainers). Only the Mistral
 * and webhook HTTP boundaries are mocked, and even those by pointing the real
 * client/relay at local mock servers — so validation, retry, breaker, locking, and
 * SKIP LOCKED all execute for real. These prove the hard requirements actually
 * hold, not that mocks were called.
 */
describe('Triage engine (integration)', () => {
  let h: Harness;

  const sampleBody = {
    subject: 'Double charged on invoice',
    body: 'I was billed twice for the Pro plan, please refund the duplicate payment',
    requesterEmail: 'alex@example.com',
  };

  const post = (body: unknown, idempotencyKey?: string) => {
    const req = request(h.http).post('/events').send(body as object);
    return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
  };
  const getTicket = (id: string) => request(h.http).get(`/tickets/${id}`);
  const ticketCount = async (): Promise<number> => {
    const rows = await h.dataSource.query('SELECT count(*)::int AS c FROM tickets');
    return rows[0].c;
  };
  const gauge = async (name: string, label: string): Promise<number | null> => {
    const res = await request(h.http).get('/metrics');
    const line = res.text
      .split('\n')
      .find((l) => l.startsWith(name) && l.includes(label));
    if (!line) return null;
    return Number(line.trim().split(/\s+/).pop());
  };

  beforeAll(async () => {
    h = await startHarness();
  }, 180000);

  afterAll(async () => {
    if (h) await h.stop();
  });

  beforeEach(async () => {
    await h.reset();
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('the same key twice produces ONE ticket and replays the response', async () => {
      const first = await post(sampleBody, 'k-dupe').expect(202);
      expect(first.body.status).toBe('accepted');
      const ticketId = first.body.ticketId;

      const second = await post(sampleBody, 'k-dupe').expect(202);
      expect(second.body.status).toBe('replayed');
      expect(second.body.ticketId).toBe(ticketId);

      expect(await ticketCount()).toBe(1);
    });

    it('the same key with a different payload is a 409 conflict', async () => {
      await post(sampleBody, 'k-conflict').expect(202);
      await post({ ...sampleBody, body: 'totally different content' }, 'k-conflict').expect(409);
    });
  });

  // ── Concurrency (the race) ───────────────────────────────────────────────────
  describe('concurrency', () => {
    it('concurrent identical submissions do not double-process', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => post(sampleBody, 'k-race')),
      );
      responses.forEach((r) => expect(r.status).toBe(202));

      const accepted = responses.filter((r) => r.body.status === 'accepted');
      expect(accepted).toHaveLength(1); // exactly one winner
      // In-flight responses legitimately return a null ticketId (the winner hadn't
      // attached the ticket yet); every non-null id must be the same one.
      const ids = new Set(
        responses.map((r) => r.body.ticketId).filter(Boolean),
      );
      expect(ids.size).toBe(1); // all resolved ids point at the same ticket
      expect(await ticketCount()).toBe(1); // the real invariant: ONE ticket
    });
  });

  // ── AI enrichment (happy path) ───────────────────────────────────────────────
  describe('enrichment', () => {
    it('classifies via the AI and emits exactly one side effect', async () => {
      const res = await post(sampleBody, 'k-ai').expect(202);
      const id = res.body.ticketId;

      const ticket = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status !== 'PENDING',
      );
      expect(ticket.enrichment.status).toBe('ENRICHED');
      expect(ticket.enrichment.source).toBe('AI');
      expect(ticket.enrichment.category).toBe('BILLING'); // from the mock

      const triaged = `ticket:${id}:ticket.triaged:v1`;
      await waitFor(
        async () => h.webhook.count(triaged),
        (c) => c === 1,
      );
      expect(h.webhook.count(`ticket:${id}:ticket.enrichment_upgraded:v1`)).toBe(0);
    });
  });

  // ── Outbox: at-least-once ────────────────────────────────────────────────────
  describe('outbox', () => {
    it('retries dispatch until the side effect is delivered', async () => {
      h.webhook.failNext(2); // first two dispatch attempts get a 500
      const res = await post(sampleBody, 'k-outbox').expect(202);
      const id = res.body.ticketId;
      const dedupKey = `ticket:${id}:ticket.triaged:v1`;

      await waitFor(
        async () => h.webhook.count(dedupKey),
        (c) => c === 1,
        { timeoutMs: 15000 },
      );

      // The relay marks SENT just after the dispatch returns; poll for it rather
      // than reading once (avoids racing the commit).
      const row = await waitFor(
        () =>
          h.dataSource
            .query(`SELECT status, attempts FROM outbox_messages WHERE dedup_key = $1`, [dedupKey])
            .then((r) => r[0]),
        (r) => r?.status === 'SENT',
        { timeoutMs: 15000 },
      );
      expect(row.status).toBe('SENT');
      expect(row.attempts).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Graceful degradation + circuit breaker ───────────────────────────────────
  describe('graceful degradation', () => {
    it('degrades to the fallback (not lost) when Mistral fails', async () => {
      h.mistral.setMode('fail');
      const res = await post(sampleBody, 'k-degrade').expect(202);
      const id = res.body.ticketId;

      const ticket = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status !== 'PENDING',
      );
      expect(ticket.enrichment.status).toBe('DEGRADED');
      expect(ticket.enrichment.source).toBe('FALLBACK');
      expect(ticket.enrichment.category).toBeTruthy(); // still classified
    });

    it('treats a malformed (schema-invalid) response as a failure and degrades', async () => {
      h.mistral.setMode('garbage');
      const res = await post(sampleBody, 'k-garbage').expect(202);
      const id = res.body.ticketId;

      const ticket = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status !== 'PENDING',
      );
      expect(ticket.enrichment.status).toBe('DEGRADED');
      expect(ticket.enrichment.source).toBe('FALLBACK');
    });

    it('opens the circuit breaker after repeated failures', async () => {
      h.mistral.setMode('fail');
      for (let i = 0; i < 8; i++) {
        await post({ ...sampleBody, subject: `fail ${i}` }, `k-breaker-${i}`).expect(202);
      }
      const state = await waitFor(
        () => gauge('circuit_breaker_state', 'mistral'),
        (v) => v === 1,
        { timeoutMs: 15000 },
      );
      expect(state).toBe(1); // 1 = open
    });

    it('upgrades a degraded ticket to AI on recovery, with a DISTINCT side effect', async () => {
      h.mistral.setMode('fail');
      const res = await post(sampleBody, 'k-upgrade').expect(202);
      const id = res.body.ticketId;
      await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status === 'DEGRADED',
      );

      // Recover: the scheduled delayed re-enrichment should upgrade it.
      h.mistral.setMode('ok');
      const upgraded = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status === 'ENRICHED' && t.enrichment.source === 'AI',
        { timeoutMs: 20000 },
      );
      expect(upgraded.enrichment.source).toBe('AI');

      // Both side effects delivered, each exactly once, on distinct dedup keys.
      await waitFor(
        async () => h.webhook.count(`ticket:${id}:ticket.enrichment_upgraded:v1`),
        (c) => c === 1,
        { timeoutMs: 20000 },
      );
      expect(h.webhook.count(`ticket:${id}:ticket.triaged:v1`)).toBe(1);

      const outbox = await h.dataSource.query(
        `SELECT event_type, status FROM outbox_messages WHERE aggregate_id = $1 ORDER BY event_type`,
        [id],
      );
      expect(outbox.map((r: { event_type: string }) => r.event_type)).toEqual([
        'ticket.enrichment_upgraded',
        'ticket.triaged',
      ]);
      outbox.forEach((r: { status: string }) => expect(r.status).toBe('SENT'));
    });
  });

  // ── Dead-letter queue ────────────────────────────────────────────────────────
  describe('DLQ', () => {
    it('dead-letters a job that exhausts its retries, with error context', async () => {
      const producer = h.app.get(PipelineProducer);
      const key = 'dlq-bogus';
      // A job pointing at a ticket that does not exist: the processor throws on
      // every attempt and the job is dead-lettered after retries are exhausted.
      await producer.enqueue({
        idempotencyKey: key,
        ticketId: randomUUID(),
        eventId: randomUUID(),
      });

      const list = await waitFor(
        () => request(h.http).get('/dlq').then((r) => r.body),
        (b) => b.count >= 1,
        { timeoutMs: 15000 },
      );
      const dl = list.items.find((i: { idempotencyKey: string }) => i.idempotencyKey === key);
      expect(dl).toBeDefined();
      expect(dl.attemptsMade).toBe(3);
      expect(dl.error.message).toBeTruthy();
    });

    it('replay re-enters through the same key without duplicating the ticket', async () => {
      // A real, fully-processed ticket.
      const res = await post(sampleBody, 'dlq-real').expect(202);
      const id = res.body.ticketId;
      const ticket = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status === 'ENRICHED',
      );
      const eventRows = await h.dataSource.query(
        `SELECT event_id FROM tickets WHERE id = $1`,
        [id],
      );
      const eventId = eventRows[0].event_id;
      const before = await ticketCount();

      // Synthesize a dead letter for it (as the worker's failure handler would).
      const payload = JSON.stringify({ idempotencyKey: 'dlq-real', ticketId: id, eventId });
      const inserted = await h.dataSource.query(
        `INSERT INTO dead_letters
           (queue, job_id, idempotency_key, payload, error_message, attempts_made, status, failed_at)
         VALUES ('ticket-pipeline','synthetic','dlq-real',$1::jsonb,'synthetic',3,'PENDING',now())
         RETURNING id`,
        [payload],
      );
      const dlId = inserted[0].id;

      await request(h.http).post(`/dlq/${dlId}/replay`).expect(202);

      // The replayed job reprocesses the existing ticket (attempts increment) but
      // creates no new ticket and emits no duplicate side effect.
      await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.attempts > ticket.enrichment.attempts,
        { timeoutMs: 15000 },
      );
      expect(await ticketCount()).toBe(before);
      expect(h.webhook.count(`ticket:${id}:ticket.triaged:v1`)).toBe(1);

      // Double replay is rejected.
      await request(h.http).post(`/dlq/${dlId}/replay`).expect(409);
    });
  });

  // ── Reconciliation sweep (ADR-0009) ──────────────────────────────────────────
  describe('reconciliation', () => {
    it('re-drives a ticket whose upgrade job was lost', async () => {
      // Degrade a ticket, then simulate a lost upgrade chain by wiping the queue
      // (as a Redis flush or crash would) — nothing is scheduled to fix it now.
      h.mistral.setMode('fail');
      const res = await post(sampleBody, 'k-reconcile').expect(202);
      const id = res.body.ticketId;
      await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status === 'DEGRADED',
      );
      await h.queue.obliterate({ force: true });

      // AI recovers, but only the sweep can rescue this ticket now.
      h.mistral.setMode('ok');
      const swept = await h.app.get(ReconcileSweeper).sweep();
      expect(swept).toBeGreaterThanOrEqual(1);

      const upgraded = await waitFor(
        () => getTicket(id).then((r) => r.body),
        (t) => t.enrichment.status === 'ENRICHED' && t.enrichment.source === 'AI',
        { timeoutMs: 15000 },
      );
      expect(upgraded.enrichment.source).toBe('AI');
    });
  });
});
