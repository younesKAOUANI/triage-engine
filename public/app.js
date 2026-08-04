/*
 * Demo client for the triage engine.
 *
 * Every call here hits the real service on the same origin. Nothing is mocked
 * and nothing is simulated — if the deployment misbehaves, this page shows it.
 *
 * Deliberately dependency-free and un-bundled: it is served as a static file, so
 * the Docker image and CI pipeline stay exactly as they were. A demo page that
 * can break the deployment is not worth having.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Current ticket under inspection. */
  let current = null;
  let pollTimer = null;

  const PRESETS = {
    billing: {
      subject: 'Double charged on invoice',
      body: 'I was billed twice for the Pro plan this month, please refund the duplicate charge.',
      email: 'alex@example.com',
    },
    account: {
      subject: 'Cannot log in to my account',
      body: 'The password reset email never arrives and my account is locked out.',
      email: 'sam@example.com',
    },
    outage: {
      subject: 'Everything is down',
      body: 'The API returns 500 for every request. This is urgent, our checkout is broken.',
      email: 'ops@example.com',
    },
    feature: {
      subject: 'Please add CSV export',
      body: 'It would be nice to export the report as CSV instead of copying it by hand.',
      email: 'jo@example.com',
    },
  };

  // ── request plumbing ────────────────────────────────────────────────────────

  async function call(method, path, { body, key } = {}) {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;

    const started = performance.now();
    let res, payload, status;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      status = res.status;
      const text = await res.text();
      try { payload = JSON.parse(text); } catch { payload = text; }
    } catch (err) {
      log('ERR', `${method} ${path}`, performance.now() - started);
      throw err;
    }
    log(status, `${method} ${path}`, performance.now() - started);
    return { status, payload };
  }

  function log(status, path, ms) {
    const box = $('log');
    box.querySelector('.empty')?.remove();
    const cls = status === 'ERR' ? 'cE' : `c${String(status)[0]}`;
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML =
      `<span class="code ${cls}">${esc(status)}</span>` +
      `<span class="path">${esc(path)}</span>` +
      `<span class="ms">${Math.round(ms)}ms</span>`;
    box.prepend(row);
    while (box.children.length > 60) box.lastChild.remove();
  }

  // ── pipeline ────────────────────────────────────────────────────────────────

  function stage(name, state) {
    const el = document.querySelector(`.pipe li[data-stage="${name}"]`);
    if (el) el.className = state || '';
  }

  function resetPipeline() {
    ['accepted', 'queued', 'classified', 'notified'].forEach((s) => stage(s, ''));
    $('classifyDetail').textContent = 'waiting for the worker…';
    $('notifyDetail').textContent = 'notification written in the same transaction, then delivered';
    $('degradedNote').hidden = true;
    $('ticketJson').textContent = '—';
  }

  async function submitTicket() {
    clearInterval(pollTimer);
    const btn = $('submit');
    btn.disabled = true;
    $('submitNote').textContent = '';

    const key = $('key').value.trim() || `demo-${Date.now()}`;
    $('key').value = key;
    const body = {
      subject: $('subject').value.trim(),
      body: $('body').value.trim(),
    };
    const email = $('email').value.trim();
    if (email) body.requesterEmail = email;

    resetPipeline();
    $('pipelineSection').hidden = false;
    $('breakSection').hidden = false;
    stage('accepted', 'active');

    try {
      const { status, payload } = await call('POST', '/events', { body, key });
      $('lastResponse').textContent = JSON.stringify(payload, null, 2);

      if (status !== 202) {
        stage('accepted', '');
        $('submitNote').textContent =
          status === 400 ? 'Rejected — see the response.' :
          status === 409 ? 'That key is already used with a different body.' :
          status === 429 ? 'Rate limited. Wait a minute and retry.' :
          `Unexpected ${status}.`;
        btn.disabled = false;
        return;
      }

      current = { key, ticketId: payload.ticketId, body };
      stage('accepted', 'done');
      stage('queued', payload.jobId ? 'done' : 'active');
      stage('classified', 'active');
      pollTicket();
    } catch {
      $('submitNote').textContent = 'Network error — is the service reachable?';
    } finally {
      btn.disabled = false;
    }
  }

  async function pollTicket() {
    if (!current?.ticketId) return;
    let tries = 0;

    const tick = async () => {
      tries++;
      const { status, payload } = await call('GET', `/tickets/${current.ticketId}`);
      if (status !== 200) return clearInterval(pollTimer);
      $('ticketJson').textContent = JSON.stringify(payload, null, 2);

      const e = payload.enrichment || {};
      if (e.status && e.status !== 'PENDING') {
        clearInterval(pollTimer);
        stage('classified', 'done');
        const ai = e.source === 'AI';
        $('classifyDetail').textContent =
          `${e.status} via ${ai ? 'the model' : 'the rule-based fallback'} — ` +
          `${e.category} / ${e.priority}, confidence ${e.confidence}`;
        $('degradedNote').hidden = e.status !== 'DEGRADED';
        checkDelivery();
      } else if (tries > 40) {
        clearInterval(pollTimer);
        $('classifyDetail').textContent = 'still pending after 40s — the worker may be backed up';
      }
    };

    await tick();
    pollTimer = setInterval(tick, 1000);
  }

  async function checkDelivery() {
    stage('notified', 'active');
    const dedupKey = `ticket:${current.ticketId}:ticket.triaged:v1`;
    for (let i = 0; i < 15; i++) {
      const { status, payload } = await call('GET', `/_sink/deliveries?dedupKey=${encodeURIComponent(dedupKey)}`);
      if (status !== 200 || typeof payload?.count !== 'number') {
        $('notifyDetail').textContent = 'the bundled consumer is not exposed on this deployment';
        stage('notified', '');
        return;
      }
      if (payload.count >= 1) {
        stage('notified', 'done');
        $('notifyDetail').textContent =
          `delivered ${payload.count}× against dedup key ${dedupKey} — one state change, one notification`;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    $('notifyDetail').textContent = 'no delivery after 15s — check outbox_pending below';
    stage('notified', '');
  }

  // ── attacks ─────────────────────────────────────────────────────────────────

  function verdict(held, title, detail) {
    const box = $('verdicts');
    const el = document.createElement('div');
    el.className = `verdict${held ? '' : ' bad'}`;
    el.innerHTML = `<div class="vh">${held ? '✓' : '✗'} ${esc(title)}</div><div class="vb">${detail}</div>`;
    box.prepend(el);
  }

  const ATTACKS = {
    async duplicate() {
      const { payload } = await call('POST', '/events', { body: current.body, key: current.key });
      $('lastResponse').textContent = JSON.stringify(payload, null, 2);
      const same = payload.ticketId === current.ticketId;
      verdict(
        payload.status === 'replayed' && same,
        'No duplicate ticket',
        `Came back <code>${esc(payload.status)}</code> with the same id <code>${esc(payload.ticketId)}</code>. ` +
          `The original response was replayed instead of the work being done twice.`,
      );
    },

    async conflict() {
      const { status, payload } = await call('POST', '/events', {
        body: { subject: 'Something else entirely', body: 'A completely different message body.' },
        key: current.key,
      });
      $('lastResponse').textContent = JSON.stringify(payload, null, 2);
      verdict(
        status === 409,
        'Key reuse with a different body refused',
        `<code>${status}</code> — the key is matched against a hash of the content, so this is ` +
          `detected rather than guessed at. Silently accepting one of the two payloads would be worse.`,
      );
    },

    async race() {
      const key = `race-${Date.now()}`;
      const body = { subject: 'Concurrent submission', body: 'Twelve identical requests fired at the same moment.' };
      const results = await Promise.all(
        Array.from({ length: 12 }, () => call('POST', '/events', { body, key }).catch(() => ({ status: 0, payload: {} }))),
      );
      const accepted = results.filter((r) => r.payload?.status === 'accepted').length;
      const ids = new Set(results.map((r) => r.payload?.ticketId).filter(Boolean));
      const limited = results.filter((r) => r.status === 429).length;
      verdict(
        accepted === 1 && ids.size <= 1,
        `One ticket from twelve simultaneous requests`,
        `${accepted} accepted, ${results.length - accepted - limited} told the work was already in flight` +
          (limited ? `, ${limited} rate limited` : '') +
          `. Distinct ticket ids returned: <code>${ids.size}</code>. ` +
          `The race is settled by a UNIQUE constraint in Postgres, not an application lock.`,
      );
    },

    async badkey() {
      const a = await call('POST', '/events', { body: current.body, key: 'order:123' });
      const b = await call('POST', '/events', { body: current.body, key: '12345' });
      $('lastResponse').textContent = JSON.stringify(a.payload, null, 2);
      verdict(
        a.status === 400 && b.status === 400,
        'Unusable keys rejected before anything is written',
        `<code>order:123</code> → ${a.status}, <code>12345</code> → ${b.status}. The key becomes a queue ` +
          `job id, and the queue rejects colons and all-digit ids. Storing the ticket first would leave one ` +
          `whose job can never be enqueued.`,
      );
    },

    async flood() {
      const codes = [];
      for (let i = 0; i < 30; i++) {
        const { status } = await call('POST', '/events', {
          body: { subject: `Flood ${i}`, body: `Automated flood request number ${i} from the demo page.` },
          key: `flood-${Date.now()}-${i}`,
        });
        codes.push(status);
      }
      const limited = codes.filter((c) => c === 429).length;
      const health = await call('GET', '/health');
      verdict(
        limited > 0 && health.status === 200,
        'Rate limited, but the probes stayed up',
        `${limited} of 30 writes rejected with <code>429</code>, and <code>/health</code> still answered ` +
          `<code>${health.status}</code>. Probes and the relay's own delivery target are exempt — a throttled ` +
          `health check reads as an outage, and a throttled consumer would throttle the engine's own notifications.`,
      );
    },
  };

  // ── metrics ─────────────────────────────────────────────────────────────────

  function metric(text, name, labels) {
    const re = new RegExp(`^${name}${labels ? `\\{[^}]*${labels}[^}]*\\}` : '(?:\\{\\})?'}\\s+([0-9.e+-]+)$`, 'm');
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  }

  async function refreshMetrics() {
    try {
      const res = await fetch('/metrics');
      if (!res.ok) return;
      const t = await res.text();
      // A counter with no series yet has genuinely counted zero. Showing a dash
      // reads as "unknown" and makes a healthy fresh instance look broken.
      const set = (id, v, invertColour) => {
        const el = $(id);
        const n = v === null ? 0 : v;
        el.textContent = n;
        if (invertColour) el.classList.toggle('zero', n === 0);
      };
      set('m_accepted', metric(t, 'events_ingested_total', 'result="accepted"'));
      set('m_duplicate', metric(t, 'events_ingested_total', 'result="duplicate"'));
      set('m_conflict', metric(t, 'events_ingested_total', 'result="conflict"'));
      set('m_queue', metric(t, 'pipeline_queue_depth', 'state="waiting"'));
      set('m_outbox', metric(t, 'outbox_pending'));
      set('m_dlq', metric(t, 'dlq_depth'), true);
      set('m_abandoned', metric(t, 'outbox_messages_failed_total'), true);
      const b = metric(t, 'circuit_breaker_state', 'breaker="mistral"');
      if (b !== null) $('m_breaker').textContent = b === 1 ? 'open' : b === 0.5 ? 'half' : 'closed';
    } catch { /* transient; the next tick retries */ }
  }

  async function refreshHealth() {
    try {
      const res = await fetch('/ready');
      const up = res.ok;
      $('dot').className = `dot ${up ? 'up' : 'down'}`;
      $('statusText').textContent = up ? 'live · postgres + redis reachable' : 'not ready';
    } catch {
      $('dot').className = 'dot down';
      $('statusText').textContent = 'unreachable';
    }
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  $('key').value = `demo-${Date.now()}`;
  $('submit').addEventListener('click', submitTicket);

  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      const p = PRESETS[c.dataset.preset];
      $('subject').value = p.subject;
      $('body').value = p.body;
      $('email').value = p.email;
      $('key').value = `demo-${Date.now()}`;
    }),
  );

  document.querySelectorAll('.attack').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!current) return;
      document.querySelectorAll('.attack').forEach((x) => (x.disabled = true));
      try {
        await ATTACKS[b.dataset.attack]();
      } catch {
        verdict(false, 'Request failed', 'The service did not respond. Check the log below.');
      } finally {
        document.querySelectorAll('.attack').forEach((x) => (x.disabled = false));
        refreshMetrics();
      }
    }),
  );

  refreshHealth();
  refreshMetrics();
  setInterval(refreshHealth, 15000);
  setInterval(refreshMetrics, 5000);
})();
