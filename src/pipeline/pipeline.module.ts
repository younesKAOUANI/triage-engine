import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { OutboxModule } from '../outbox/outbox.module';
import { buildRedisOptions } from '../redis/redis.constants';
import { TicketsModule } from '../tickets/tickets.module';
import { DlqController } from './dlq/dlq.controller';
import { DlqService } from './dlq/dlq.service';
import { DeadLetterEntity } from './dlq/entities/dead-letter.entity';
import { ENRICHER } from './enricher.port';
import { PipelineObserver } from './pipeline.observer';
import { PipelineProducer } from './pipeline.producer';
import { PIPELINE_QUEUE } from './pipeline.constants';
import { PlaceholderEnricher } from './placeholder.enricher';
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
  ],
  controllers: [DlqController],
  providers: [
    PipelineProducer,
    TicketProcessor,
    DlqService,
    PipelineObserver,
    // The enrichment seam. The AI layer overrides this single binding.
    { provide: ENRICHER, useClass: PlaceholderEnricher },
  ],
  exports: [PipelineProducer],
})
export class PipelineModule {}
