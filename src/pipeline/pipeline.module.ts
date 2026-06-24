import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { OutboxModule } from '../outbox/outbox.module';
import { buildRedisOptions } from '../redis/redis.constants';
import { TicketsModule } from '../tickets/tickets.module';
import { DlqController } from './dlq/dlq.controller';
import { DlqService } from './dlq/dlq.service';
import { DeadLetterEntity } from './dlq/entities/dead-letter.entity';
import { PipelineObserver } from './pipeline.observer';
import { PipelineProducer } from './pipeline.producer';
import { PIPELINE_QUEUE } from './pipeline.constants';
import { ReconcileSweeper } from './reconcile.sweeper';
import { TicketProcessor } from './ticket.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: EnvVars) => ({
        connection: buildRedisOptions(env),
      }),
    }),
    BullModule.registerQueue({ name: PIPELINE_QUEUE }),
    TypeOrmModule.forFeature([DeadLetterEntity]),
    TicketsModule,
    OutboxModule,
    // Provides the ENRICHER binding (AI enricher with circuit breaker + fallback).
    EnrichmentModule,
  ],
  controllers: [DlqController],
  providers: [
    PipelineProducer,
    TicketProcessor,
    DlqService,
    PipelineObserver,
    ReconcileSweeper,
  ],
  exports: [PipelineProducer, ReconcileSweeper],
})
export class PipelineModule {}
