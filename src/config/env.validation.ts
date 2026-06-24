import { z } from 'zod';

/**
 * Single source of truth for configuration. The app refuses to boot if the
 * environment is invalid (fail fast, loudly) rather than discovering a missing
 * value deep in a request handler. zod handles both validation and coercion of
 * the string-typed `process.env` into real numbers/booleans.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // PostgreSQL
  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1).default('triage'),
  POSTGRES_PASSWORD: z.string().min(1).default('triage'),
  POSTGRES_DB: z.string().min(1).default('triage'),
  DB_RUN_MIGRATIONS_ON_BOOT: z.coerce.boolean().default(false),

  // Redis / BullMQ
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Pipeline retry policy
  PIPELINE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  PIPELINE_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(2000),
  PIPELINE_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(60000),

  // Idempotency
  IDEMPOTENCY_LEASE_MS: z.coerce.number().int().min(1000).default(300000),

  // Outbox relay
  OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).default(20),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(2000),
  WEBHOOK_TARGET_URL: z
    .string()
    .url()
    .default('http://localhost:3000/_sink/webhook'),

  // Mistral (consumed by the AI layer; validated here so the contract is one place)
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().min(1).default('mistral-small-latest'),
  MISTRAL_TIMEOUT_MS: z.coerce.number().int().min(100).default(10000),
  MISTRAL_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  // Override the SDK base URL — lets tests point the real client at a mock HTTP
  // server (so only the HTTP boundary is faked, nothing internal).
  MISTRAL_SERVER_URL: z.string().url().optional(),

  // Graceful-degradation re-enrichment: a DEGRADED ticket is re-queued on a
  // delay to attempt an AI upgrade later (decoupled from breaker state to avoid a
  // recovery stampede — see ADR-0005).
  ENRICHMENT_UPGRADE_MAX_ATTEMPTS: z.coerce.number().int().min(0).default(5),
  ENRICHMENT_UPGRADE_BACKOFF_MS: z.coerce.number().int().min(1000).default(30000),

  // Reconciliation sweep (ADR-0009): periodically re-drives tickets stuck DEGRADED
  // (lost upgrade job, crash, or exhausted attempts) so none stays degraded forever.
  RECONCILE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  RECONCILE_DEGRADED_AFTER_MS: z.coerce.number().int().min(0).default(300000),
  RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).default(50),

  // Circuit breaker (opossum)
  CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50),
  CIRCUIT_BREAKER_VOLUME_THRESHOLD: z.coerce.number().int().min(1).default(5),
  // Backstop above the client's AbortController timeout, so the client aborts first.
  CIRCUIT_BREAKER_TIMEOUT_MS: z.coerce.number().int().min(100).default(12000),
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().min(1000).default(30000),
});

export type EnvVars = z.infer<typeof envSchema>;

/**
 * `validate` hook for @nestjs/config. Throwing here aborts bootstrap with a
 * readable list of every offending variable instead of one-at-a-time failures.
 */
export function validateEnv(config: Record<string, unknown>): EnvVars {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
