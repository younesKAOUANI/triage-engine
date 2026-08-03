import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

/**
 * Readiness indicator for Redis. Terminus ships no Redis indicator, so we PING
 * the shared client. A timeout guards against a half-open connection that never
 * resolves (which would otherwise hang the readiness probe).
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string, timeoutMs = 2000) {
    const indicator = this.healthIndicatorService.check(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      // Typed as `string`, not the literal ioredis declares: a half-open or
      // proxied connection can reply with something else, and that is precisely
      // the case this probe exists to catch.
      const pong: string = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('redis ping timed out')),
            timeoutMs,
          );
        }),
      ]);
      if (pong !== 'PONG') {
        return indicator.down({ message: `unexpected ping reply: ${pong}` });
      }
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    } finally {
      // Readiness is probed every few seconds; leaving the loser of the race
      // pending would queue a timer per probe for no reason.
      clearTimeout(timer);
    }
  }
}
