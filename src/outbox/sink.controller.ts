import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_ALL } from '../common/rate-limit/rate-limit.module';

/**
 * Cap on retained delivery records. The endpoint below is publicly writable, so
 * an unbounded map is a way to grow the process until the host runs out of
 * memory. Oldest entries are evicted first.
 */
const MAX_TRACKED_DELIVERIES = 5000;

/** Dedup keys are `<type>:<uuid>:<event>:<version>`; anything longer is junk. */
const MAX_KEY_LENGTH = 200;

/**
 * A stand-in for an external notification consumer, so the whole stack runs
 * offline with no real webhook endpoint. It is deliberately idempotent: it keys
 * on the Idempotency-Key header and collapses repeat deliveries — exactly the
 * behaviour our at-least-once outbox relies on the downstream having.
 *
 * Purely a local simulation; a real deployment points WEBHOOK_TARGET_URL at the
 * actual consumer and this controller is irrelevant.
 */
// The relay dispatches to this controller in the bundled demo setup, so it
// must never be rate limited: throttling it would throttle the engine's own
// deliveries and manufacture outbox retries.
@SkipThrottle(SKIP_ALL)
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
    const key = (idempotencyKey ?? 'none').slice(0, MAX_KEY_LENGTH);
    const seen = (this.deliveries.get(key) ?? 0) + 1;
    this.deliveries.set(key, seen);
    // Map iteration is insertion-ordered, so the first key is the oldest.
    while (this.deliveries.size > MAX_TRACKED_DELIVERIES) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }

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

  /**
   * Inspection endpoint for the demo.
   *
   * It deliberately does NOT list the keys. A dedup key embeds the ticket id
   * (`ticket:<uuid>:ticket.triaged:v1`), so returning them let any anonymous
   * caller enumerate every ticket on the deployment and then read each one
   * through `GET /tickets/:id` — which exposes the submitter's email address and
   * message body. That was live for a short window; it is the reason this now
   * answers only for a key you already hold.
   *
   * Pass `?dedupKey=` to check a delivery you triggered yourself. Without it you
   * get totals only, which is all the demo actually needs.
   */
  @Get('deliveries')
  list(@Query('dedupKey') dedupKey?: string) {
    if (dedupKey) {
      return {
        dedupKey,
        count: this.deliveries.get(dedupKey.slice(0, MAX_KEY_LENGTH)) ?? 0,
      };
    }
    let total = 0;
    for (const count of this.deliveries.values()) total += count;
    return { unique: this.deliveries.size, total };
  }
}
