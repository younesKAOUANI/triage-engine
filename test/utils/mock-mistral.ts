import { createServer, Server } from 'node:http';

export type MistralMode = 'ok' | 'fail' | 'garbage';

export interface MockMistral {
  url: string;
  setMode(mode: MistralMode): void;
  callCount(): number;
  resetCount(): void;
  close(): Promise<void>;
}

/**
 * A stand-in for the Mistral chat-completions HTTP endpoint. The real SDK is
 * pointed at this via MISTRAL_SERVER_URL, so the client, JSON parsing, zod
 * validation, retry, and circuit breaker all run for real — only the network
 * boundary is faked (per the testing strategy / ADR-0005).
 *
 *  - ok:      a valid, correctly-shaped completion
 *  - fail:    HTTP 500 (transient network/server failure)
 *  - garbage: HTTP 200 with valid JSON of the WRONG shape (exercises the
 *             validation-failure-as-transient path)
 */
export async function startMockMistral(
  classification: Record<string, unknown> = {
    category: 'BILLING',
    priority: 'HIGH',
    summary: 'AI-classified: billing issue',
    confidence: 0.9,
  },
): Promise<MockMistral> {
  let mode: MistralMode = 'ok';
  let calls = 0;

  const server: Server = createServer((req, res) => {
    const isCompletion = req.url?.includes('/chat/completions');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (isCompletion) {
        calls += 1;
      }
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock upstream failure' }));
        return;
      }
      const content =
        mode === 'garbage'
          ? JSON.stringify({ unexpected: 'shape' })
          : JSON.stringify(classification);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(completion(content));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    setMode: (m) => {
      mode = m;
    },
    callCount: () => calls,
    resetCount: () => {
      calls = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function completion(content: string): string {
  return JSON.stringify({
    id: 'mock-cmpl',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mistral-small-latest',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
