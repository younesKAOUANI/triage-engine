/**
 * Seeds a few sample tickets by POSTing to a running instance. Run with
 * `make seed` (after `make up`). Demonstrates both modes: events with an explicit
 * idempotency key and events without one (key derived from content).
 */
const BASE_URL = `http://localhost:${process.env.PORT ?? 3000}`;

interface SampleEvent {
  idempotencyKey?: string;
  subject: string;
  body: string;
  requesterEmail?: string;
  source?: string;
}

const samples: SampleEvent[] = [
  {
    idempotencyKey: 'seed-billing-001',
    subject: 'Double charged on my invoice',
    body: 'I was billed twice for the Pro plan this month. Please refund the duplicate charge.',
    requesterEmail: 'alex@example.com',
    source: 'email',
  },
  {
    idempotencyKey: 'seed-tech-001',
    subject: 'App crashes on export',
    body: 'Every time I export a report to PDF the app freezes and I have to force quit.',
    requesterEmail: 'sam@example.com',
    source: 'web',
  },
  {
    // No idempotency key — the server derives one from the content hash.
    subject: 'How do I reset my password?',
    body: 'I forgot my password and the reset email never arrives.',
    requesterEmail: 'jordan@example.com',
    source: 'chat',
  },
];

async function main(): Promise<void> {
  for (const sample of samples) {
    const res = await fetch(`${BASE_URL}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sample),
    });
    const json = await res.json();
    // eslint-disable-next-line no-console
    console.log(`POST /events -> ${res.status}`, json);
  }
  // eslint-disable-next-line no-console
  console.log(`\nInspect a ticket:  GET ${BASE_URL}/tickets/<id>`);
  // eslint-disable-next-line no-console
  console.log(`Webhook sink:      GET ${BASE_URL}/_sink/deliveries`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('seed failed:', error);
  process.exit(1);
});
