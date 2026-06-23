import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';

/**
 * A stand-in for an external notification consumer, so the whole stack runs
 * offline with no real webhook endpoint. It is deliberately idempotent: it keys
 * on the Idempotency-Key header and collapses repeat deliveries — exactly the
 * behaviour our at-least-once outbox relies on the downstream having.
 *
 * Purely a local simulation; a real deployment points WEBHOOK_TARGET_URL at the
 * actual consumer and this controller is irrelevant.
 */
@Controller('_sink')
export class SinkController {
  private readonly logger = new Logger('WebhookSink');
  private readonly deliveries = new Map<string, number>();

  @Post('webhook')
  @HttpCode(200)
  receive(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: { eventType?: string },
  ) {
    const seen = (this.deliveries.get(idempotencyKey) ?? 0) + 1;
    this.deliveries.set(idempotencyKey, seen);

    if (seen > 1) {
      this.logger.log(
        { idempotencyKey, deliveryCount: seen },
        'duplicate side-effect delivery deduplicated',
      );
    } else {
      this.logger.log(
        { idempotencyKey, eventType: body?.eventType },
        'side effect received',
      );
    }
    return { received: true, duplicate: seen > 1 };
  }

  /** Inspection endpoint for the demo: how many unique effects, and per-key counts. */
  @Get('deliveries')
  list() {
    return {
      unique: this.deliveries.size,
      deliveries: [...this.deliveries.entries()].map(([dedupKey, count]) => ({
        dedupKey,
        count,
      })),
    };
  }
}
