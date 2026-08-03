import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_ALL } from '../common/rate-limit/rate-limit.module';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

/**
 * Two distinct probes, deliberately:
 *  - GET /health  (liveness):  is the process up and the event loop responsive?
 *    Kubernetes restarts the pod if this fails. It must NOT depend on Postgres or
 *    Redis — a transient DB blip shouldn't trigger a restart loop.
 *  - GET /ready   (readiness): can this instance actually serve traffic right now?
 *    Checks Postgres and Redis. A failure here pulls the instance out of the load
 *    balancer without killing it, so it can recover.
 */
// A throttled probe would be read as the instance being down.
@SkipThrottle(SKIP_ALL)
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('health')
  @HealthCheck()
  liveness() {
    // Intentionally dependency-free: if this handler runs, we're alive.
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('postgres', { timeout: 2000 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
