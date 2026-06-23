import type { RedisOptions } from 'ioredis';
import { EnvVars } from '../config/env.validation';

/** DI token for the shared ioredis client (used by health checks). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * ioredis options shared by the health-check client and BullMQ.
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ: its blocking commands
 * (BRPOPLPUSH etc.) must not be aborted by ioredis's per-request retry cap.
 */
export function buildRedisOptions(env: EnvVars): RedisOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}
