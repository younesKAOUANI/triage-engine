import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookDispatcher } from './dispatchers/webhook.dispatcher';
import { OUTBOX_DISPATCHER } from './dispatchers/outbox-dispatcher.port';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';
import { SinkController } from './sink.controller';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessageEntity])],
  controllers: [SinkController],
  providers: [
    OutboxService,
    OutboxRelay,
    { provide: OUTBOX_DISPATCHER, useClass: WebhookDispatcher },
  ],
  // OutboxService is exported so the pipeline can emit side effects inside its
  // own transaction. The relay is internal — nothing else drives it.
  exports: [OutboxService],
})
export class OutboxModule {}
