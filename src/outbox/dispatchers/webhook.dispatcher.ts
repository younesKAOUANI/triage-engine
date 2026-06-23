import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/app-config.module';
import {
  CORRELATION_HEADER,
  getCorrelationId,
} from '../../common/correlation/correlation';
import { EnvVars } from '../../config/env.validation';
import { DispatchMessage, OutboxDispatcher } from './outbox-dispatcher.port';

/** Hard cap on a single dispatch so the relay can't hang on a stuck target. */
const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Delivers a side effect by POSTing it to a configured URL. The dedup key is sent
 * as the `Idempotency-Key` header so the (idempotent) consumer can collapse the
 * duplicate deliveries our at-least-once guarantee may produce. The correlation
 * id is forwarded so the trace continues across the network boundary.
 */
@Injectable()
export class WebhookDispatcher implements OutboxDispatcher {
  constructor(@Inject(APP_ENV) private readonly env: EnvVars) {}

  async dispatch(message: DispatchMessage): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(this.env.WEBHOOK_TARGET_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': message.dedupKey,
          [CORRELATION_HEADER]: getCorrelationId() ?? '',
        },
        body: JSON.stringify({
          eventType: message.eventType,
          aggregateType: message.aggregateType,
          aggregateId: message.aggregateId,
          payload: message.payload,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `webhook target returned ${response.status} ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
