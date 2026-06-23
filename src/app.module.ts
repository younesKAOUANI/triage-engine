import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from './common/logging/logging.config';
import { APP_ENV, AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './config/database.module';
import { EnvVars } from './config/env.validation';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { MetricsModule } from './observability/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { RedisModule } from './redis/redis.module';
import { TicketsModule } from './tickets/tickets.module';

@Module({
  imports: [
    // Foundations: config, logging, datastores, observability.
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: EnvVars) => buildLoggerParams(env),
    }),
    DatabaseModule,
    RedisModule,
    MetricsModule,
    HealthModule,

    // Domain: ingestion -> idempotency -> pipeline -> outbox.
    IdempotencyModule,
    TicketsModule,
    EventsModule,
    PipelineModule,
    OutboxModule,
  ],
})
export class AppModule {}
