import { createServer, Server } from 'node:http';

export interface MockWebhook {
  url: string;
  /** Number of *successful* deliveries for a dedup key (or total if omitted). */
  count(dedupKey?: string): number;
  /** Force the next `n` deliveries to fail with 500 (to exercise retries). */
  failNext(n: number): void;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Stand-in for the downstream notification consumer. Records deliveries keyed by
 * the Idempotency-Key header so tests can assert at-least-once delivery and the
 * absence of duplicates. Can be told to fail the next N deliveries to exercise the
 * outbox relay's retry/backoff.
 */
export async function startMockWebhook(): Promise<MockWebhook> {
  const deliveries = new Map<string, number>();
  let failRemaining = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (failRemaining > 0) {
        failRemaining -= 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock webhook failure' }));
        return;
      }
      const key = (req.headers['idempotency-key'] as string) ?? '';
      deliveries.set(key, (deliveries.get(key) ?? 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/webhook`,
    count: (dedupKey) =>
      dedupKey
        ? (deliveries.get(dedupKey) ?? 0)
        : [...deliveries.values()].reduce((a, b) => a + b, 0),
    failNext: (n) => {
      failRemaining = n;
    },
    reset: () => {
      deliveries.clear();
      failRemaining = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
