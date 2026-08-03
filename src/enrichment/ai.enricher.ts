import { Inject, Injectable, Logger } from '@nestjs/common';
import { backoffWithJitter } from '../common/backoff/backoff';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { MetricsService } from '../observability/metrics.service';
import { TicketEntity } from '../tickets/entities/ticket.entity';
import { EnrichmentSource, EnrichmentStatus } from '../tickets/ticket.enums';
import { Enricher, EnrichmentOutcome } from '../pipeline/enricher.port';
import { FallbackClassifier } from './fallback.classifier';
import { LlmEnrichment } from './llm-response.schema';
import { MistralCircuitBreaker } from './mistral.circuit-breaker';
import { MistralClient } from './mistral.client';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The production enricher (bound to the ENRICHER token). It implements the
 * project's graceful-degradation contract (ADR-0005):
 *
 *   AI succeeds  -> { ENRICHED, AI }
 *   AI fails/unavailable/garbage -> { DEGRADED, FALLBACK }   (never throws)
 *
 * It NEVER throws: a ticket is never dropped because the model is down. The
 * DEGRADED result is a usable classification now; the pipeline separately
 * schedules an AI re-enrichment to upgrade it later.
 *
 * Resilience order: a short retry loop (exponential backoff + jitter) wraps the
 * breaker. If the breaker is open we skip straight to fallback rather than spin on
 * fast-failing calls; transient errors are retried up to MISTRAL_MAX_RETRIES.
 */
@Injectable()
export class AiEnricher implements Enricher {
  private readonly logger = new Logger(AiEnricher.name);

  constructor(
    private readonly client: MistralClient,
    private readonly breaker: MistralCircuitBreaker,
    private readonly fallback: FallbackClassifier,
    private readonly metrics: MetricsService,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  async enrich(ticket: TicketEntity): Promise<EnrichmentOutcome> {
    // No key configured, or breaker already open: don't even attempt — degrade.
    if (!this.client.isConfigured()) {
      return this.degrade(ticket, 'mistral not configured');
    }
    if (this.breaker.isOpen) {
      return this.degrade(ticket, 'circuit open');
    }

    const stopTimer = this.metrics.enrichmentLatency.startTimer({
      source: 'ai',
    });
    try {
      const result = await this.callWithRetry(ticket);
      stopTimer();
      this.metrics.enrichmentResults.inc({ source: 'ai', result: 'success' });
      return {
        status: EnrichmentStatus.ENRICHED,
        source: EnrichmentSource.AI,
        ...result,
      };
    } catch (error) {
      stopTimer();
      this.metrics.enrichmentResults.inc({ source: 'ai', result: 'failed' });
      return this.degrade(ticket, (error as Error).message);
    }
  }

  /** Retry transient failures with backoff+jitter; bail out if the breaker trips. */
  private async callWithRetry(ticket: TicketEntity): Promise<LlmEnrichment> {
    const maxAttempts = this.env.MISTRAL_MAX_RETRIES + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.breaker.fire(ticket);
      } catch (error) {
        lastError = error;
        // The breaker just opened (or was open): retrying will only fast-fail.
        if (this.breaker.isOpen || attempt >= maxAttempts) {
          throw error;
        }
        const delay = backoffWithJitter(attempt, { baseMs: 500, maxMs: 5000 });
        this.logger.warn(
          { attempt, retryInMs: delay, err: (error as Error).message },
          'mistral call failed; retrying',
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  private degrade(ticket: TicketEntity, reason: string): EnrichmentOutcome {
    const stopTimer = this.metrics.enrichmentLatency.startTimer({
      source: 'fallback',
    });
    const result = this.fallback.classify(ticket);
    stopTimer();
    this.metrics.enrichmentResults.inc({
      source: 'fallback',
      result: 'degraded',
    });
    this.logger.warn(
      { ticketId: ticket.id, reason },
      'enrichment degraded to rule-based fallback',
    );
    return {
      status: EnrichmentStatus.DEGRADED,
      source: EnrichmentSource.FALLBACK,
      ...result,
    };
  }
}
