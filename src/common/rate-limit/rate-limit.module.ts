import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_ENV, AppConfigModule } from '../../config/app-config.module';
import { EnvVars } from '../../config/env.validation';

/** Named limits, referenced by `@Throttle({ [WRITE_LIMIT]: {...} })` at call sites. */
export const READ_LIMIT = 'read';
export const WRITE_LIMIT = 'write';

/**
 * Per-IP rate limiting for the public deployment.
 *
 * Two named buckets rather than one: reads are what make the demo inspectable
 * (a visitor polling a ticket while it moves through the pipeline should not be
 * throttled at the same rate as someone submitting work), while ingestion and
 * DLQ replay actually create rows and queue jobs.
 *
 * The guard is registered globally so a new endpoint is limited by default and
 * has to opt out explicitly. Health, readiness and metrics opt out, because a
 * throttled probe would be read as an outage.
 */
@Module({
  imports: [
    AppConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [APP_ENV],
      useFactory: (env: EnvVars) => ({
        throttlers: [
          {
            name: READ_LIMIT,
            ttl: env.RATE_LIMIT_TTL_MS,
            limit: env.RATE_LIMIT_GLOBAL,
          },
          {
            name: WRITE_LIMIT,
            ttl: env.RATE_LIMIT_TTL_MS,
            limit: env.RATE_LIMIT_WRITES,
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
