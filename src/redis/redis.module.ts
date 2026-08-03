import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { buildRedisOptions, REDIS_CLIENT } from './redis.constants';

/**
 * Provides a single shared ioredis client for liveness/readiness checks. BullMQ
 * manages its own connections (see PipelineModule), but reuses buildRedisOptions
 * so the two never diverge on host/credentials.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_ENV],
      useFactory: (env: EnvVars) => {
        const client = new Redis(buildRedisOptions(env));
        // ioredis emits 'error' on every failed reconnect attempt. With no
        // listener, EventEmitter rethrows and an unreachable Redis becomes an
        // uncaught exception instead of a readiness failure.
        const logger = new Logger('RedisClient');
        client.on('error', (error: Error) => {
          logger.error({ err: error }, 'redis client error');
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
