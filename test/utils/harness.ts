import { ValidationPipe, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RedisContainer,
  StartedRedisContainer,
} from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { Logger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AiEnricher } from '../../src/enrichment/ai.enricher';
import {
  ENRICHER,
  Enricher,
  EnrichmentOutcome,
} from '../../src/pipeline/enricher.port';
import { PIPELINE_QUEUE } from '../../src/pipeline/pipeline.constants';
import { TicketProcessor } from '../../src/pipeline/ticket.processor';
import { TicketEntity } from '../../src/tickets/entities/ticket.entity';
import { MockMistral, startMockMistral } from './mock-mistral';
import { MockWebhook, startMockWebhook } from './mock-webhook';

/**
 * Wraps the real AiEnricher so a test can inject a fault at the pipeline's
 * enrichment step — the only seam where an arbitrary error can reach the worker's
 * failure handling. With nothing armed it delegates untouched, so every other
 * test still exercises the genuine AI path end to end.
 */
class FaultInjectingEnricher implements Enricher {
  private fault: Error | null = null;

  constructor(private readonly inner: Enricher) {}

  arm(error: Error | null): void {
    this.fault = error;
  }

  async enrich(ticket: TicketEntity): Promise<EnrichmentOutcome> {
    if (this.fault) {
      throw this.fault;
    }
    return this.inner.enrich(ticket);
  }
}

export interface Harness {
  app: INestApplication;
  http: ReturnType<INestApplication['getHttpServer']>;
  dataSource: DataSource;
  queue: Queue;
  /** The live pipeline worker, for tests that need to pause/resume processing. */
  worker: Worker;
  mistral: MockMistral;
  webhook: MockWebhook;
  /** Fault injection for failure-path tests. Cleared by reset(). */
  faults: {
    /** Make the next enrichment(s) throw `error`; pass null to disarm. */
    enricherThrows(error: Error | null): void;
  };
  /** Truncate all tables, drain the queue, and reset the mocks (per-test isolation). */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Spins up the FULL stack for integration tests: real Postgres + Redis via
 * Testcontainers, real Nest app (migrations run on boot), and HTTP mocks for the
 * Mistral and webhook boundaries. Env is set before the app is created so the
 * config module picks up the container coordinates.
 */
export async function startHarness(): Promise<Harness> {
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const redis: StartedRedisContainer = await new RedisContainer(
    'redis:7-alpine',
  ).start();
  const mistral = await startMockMistral();
  const webhook = await startMockWebhook();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    POSTGRES_HOST: postgres.getHost(),
    POSTGRES_PORT: String(postgres.getPort()),
    POSTGRES_USER: postgres.getUsername(),
    POSTGRES_PASSWORD: postgres.getPassword(),
    POSTGRES_DB: postgres.getDatabase(),
    DB_RUN_MIGRATIONS_ON_BOOT: 'true',
    REDIS_HOST: redis.getHost(),
    REDIS_PORT: String(redis.getPort()),
    MISTRAL_API_KEY: 'test-key',
    MISTRAL_SERVER_URL: mistral.url,
    MISTRAL_MAX_RETRIES: '0',
    WEBHOOK_TARGET_URL: webhook.url,
    // Tight timings so the suite runs fast.
    OUTBOX_RELAY_POLL_INTERVAL_MS: '150',
    OUTBOX_BACKOFF_BASE_MS: '100',
    PIPELINE_MAX_ATTEMPTS: '3',
    PIPELINE_BACKOFF_BASE_MS: '50',
    PIPELINE_BACKOFF_MAX_MS: '200',
    CIRCUIT_BREAKER_VOLUME_THRESHOLD: '3',
    CIRCUIT_BREAKER_RESET_MS: '1000',
    ENRICHMENT_UPGRADE_BACKOFF_MS: '1000',
    ENRICHMENT_UPGRADE_MAX_ATTEMPTS: '5',
    // Sweep never auto-fires during a test (huge interval); tests call sweep()
    // directly. Age threshold 0 so any DEGRADED ticket is eligible immediately.
    RECONCILE_SWEEP_INTERVAL_MS: '600000',
    RECONCILE_DEGRADED_AFTER_MS: '0',
    RECONCILE_BATCH_SIZE: '50',
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    // Keep the real enricher (and therefore the real Mistral client, breaker and
    // fallback) behind a thin wrapper that tests can arm with a fault.
    .overrideProvider(ENRICHER)
    .useFactory({
      factory: (real: AiEnricher) => new FaultInjectingEnricher(real),
      inject: [AiEnricher],
    })
    .compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  const dataSource = app.get(DataSource);
  const queue = app.get<Queue>(getQueueToken(PIPELINE_QUEUE));
  const processor = app.get(TicketProcessor);
  const enricher = app.get<FaultInjectingEnricher>(ENRICHER);

  const reset = async (): Promise<void> => {
    // Disarm faults before draining, so a job picked up mid-reset can't fail.
    enricher.arm(null);
    // Drain the worker first: pause() waits for any active job to finish its
    // transaction, so TRUNCATE can't deadlock against a job mid-write. Then clear
    // queued/delayed jobs and the tables, and resume.
    await processor.worker.pause();
    await queue.obliterate({ force: true });
    await dataSource.query(
      'TRUNCATE TABLE dead_letters, outbox_messages, idempotency_keys, tickets, events RESTART IDENTITY CASCADE',
    );
    processor.worker.resume();
    mistral.setMode('ok');
    mistral.resetCount();
    webhook.reset();
  };

  const stop = async (): Promise<void> => {
    await app.close();
    await mistral.close();
    await webhook.close();
    await redis.stop();
    await postgres.stop();
  };

  return {
    app,
    http: app.getHttpServer(),
    dataSource,
    queue,
    worker: processor.worker,
    mistral,
    webhook,
    faults: {
      enricherThrows: (error: Error | null) => enricher.arm(error),
    },
    reset,
    stop,
  };
}

/** Poll `read` until `predicate` is true or the timeout elapses. */
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 10000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
  }
  return last;
}
