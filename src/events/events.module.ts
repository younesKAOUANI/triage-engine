import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { EventEntity } from './entities/event.entity';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [
    // Registers EventEntity (and re-registers TicketEntity) so the ingestion
    // transaction can create both via the EntityManager.
    TypeOrmModule.forFeature([EventEntity, TicketEntity]),
    IdempotencyModule,
    PipelineModule,
  ],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
