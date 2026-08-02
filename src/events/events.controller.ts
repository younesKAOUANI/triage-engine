import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WRITE_LIMIT } from '../common/rate-limit/rate-limit.module';
import { CreateEventDto } from './dto/create-event.dto';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Ingest a support-ticket event. Always 202 (async pipeline) for accepted /
   * in-flight / replayed; a key reused with a different payload surfaces as 409
   * (thrown from the service). The idempotency key may be supplied via the
   * `Idempotency-Key` header or the body; otherwise it is derived from the content.
   */
  @Post()
  @HttpCode(202)
  @Throttle({ [WRITE_LIMIT]: {} })
  ingest(
    @Body() dto: CreateEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.events.ingest(dto, idempotencyKey);
  }
}
