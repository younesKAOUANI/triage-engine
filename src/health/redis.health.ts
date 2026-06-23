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
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs),
        ),
      ]);
      if (pong !== 'PONG') {
        return indicator.down({ message: `unexpected ping reply: ${pong}` });
      }
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }
}
