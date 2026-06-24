import { Inject, Injectable, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { MetricsService } from '../observability/metrics.service';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { MistralClient } from './mistral.client';
import { LlmEnrichment } from './llm-response.schema';

/**
 * Circuit breaker around the Mistral call, using opossum (ADR-0003: use a proven
 * library, don't hand-roll the half-open state machine).
 *
 * - Opens once failures exceed errorThresholdPercentage within the rolling
 *   window, but only after volumeThreshold calls (so one early blip can't open it).
 * - While open, fire() rejects immediately — the enricher takes the fallback path
 *   without hammering a known-bad dependency.
 * - After resetTimeout it goes half-open and lets a single probe through; success
 *   closes it, failure re-opens.
 * - opossum's own `timeout` is a backstop to the client's AbortController.
 *
 * Every state transition is pushed to the circuit_breaker_state gauge, so the
 * breaker's health is observable (0 closed / 0.5 half-open / 1 open) — degradation
 * is visible, not silent.
 */
@Injectable()
export class MistralCircuitBreaker {
  private readonly logger = new Logger(MistralCircuitBreaker.name);
  private readonly breaker: CircuitBreaker<[TicketEntity], LlmEnrichment>;

  constructor(
    client: MistralClient,
    @Inject(APP_ENV) env: EnvVars,
    private readonly metrics: MetricsService,
  ) {
    this.breaker = new CircuitBreaker(
      (ticket: TicketEntity) => client.classify(ticket),
      {
        name: 'mistral',
        timeout: env.CIRCUIT_BREAKER_TIMEOUT_MS,
        errorThresholdPercentage: env.CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT,
        volumeThreshold: env.CIRCUIT_BREAKER_VOLUME_THRESHOLD,
        resetTimeout: env.CIRCUIT_BREAKER_RESET_MS,
      },
    );

    this.setState(0); // start closed
    this.breaker.on('open', () => {
      this.setState(1);
      this.logger.warn('mistral circuit breaker OPEN — degrading to fallback');
    });
    this.breaker.on('halfOpen', () => {
      this.setState(0.5);
      this.logger.warn('mistral circuit breaker HALF-OPEN — probing');
    });
    this.breaker.on('close', () => {
      this.setState(0);
      this.logger.log('mistral circuit breaker CLOSED — recovered');
    });
  }

  fire(ticket: TicketEntity): Promise<LlmEnrichment> {
    return this.breaker.fire(ticket);
  }

  get isOpen(): boolean {
    return this.breaker.opened;
  }

  private setState(value: number): void {
    this.metrics.circuitBreakerState.set({ breaker: 'mistral' }, value);
  }
}
