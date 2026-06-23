import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * Central Prometheus registry and the metric surface of the whole engine.
 *
 * Defined in one place so every layer (ingestion, pipeline, outbox, enrichment)
 * shares the same metric instances and naming stays consistent. A private
 * Registry (rather than the global default) keeps metrics isolated and makes the
 * service trivially resettable in tests.
 *
 * The metric set maps directly onto the project's "nothing is silently lost"
 * theme: counters for what entered vs. what completed/failed, gauges for the
 * depths of every buffer (queue, DLQ, outbox) where work could pile up unseen,
 * and a gauge for circuit-breaker state so degradation is observable.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // ── Ingestion ──────────────────────────────────────────────────────────────
  /** result: accepted | duplicate | conflict */
  readonly eventsIngested = new Counter({
    name: 'events_ingested_total',
    help: 'Events received at POST /events, by ingestion outcome.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  // ── Pipeline ───────────────────────────────────────────────────────────────
  readonly eventsProcessed = new Counter({
    name: 'events_processed_total',
    help: 'Pipeline jobs that completed successfully.',
    registers: [this.registry],
  });

  readonly eventsFailed = new Counter({
    name: 'events_failed_total',
    help: 'Pipeline job failures, by terminal disposition.',
    labelNames: ['disposition'] as const, // retry | dead_letter
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: 'pipeline_queue_depth',
    help: 'Jobs waiting + delayed in the pipeline queue.',
    labelNames: ['state'] as const, // waiting | active | delayed | failed
    registers: [this.registry],
  });

  readonly dlqDepth = new Gauge({
    name: 'dlq_depth',
    help: 'Rows currently in the dead_letters table awaiting replay.',
    registers: [this.registry],
  });

  // ── Enrichment (AI layer) ──────────────────────────────────────────────────
  readonly enrichmentLatency = new Histogram({
    name: 'enrichment_latency_seconds',
    help: 'Wall-clock latency of an enrichment attempt.',
    labelNames: ['source'] as const, // ai | fallback
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly enrichmentResults = new Counter({
    name: 'enrichment_results_total',
    help: 'Enrichment outcomes by source and result.',
    labelNames: ['source', 'result'] as const, // source: ai|fallback ; result: success|degraded|deferred
    registers: [this.registry],
  });

  /** 0 = closed, 1 = open, 0.5 = half-open. */
  readonly circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Mistral circuit breaker state (0 closed, 0.5 half-open, 1 open).',
    labelNames: ['breaker'] as const,
    registers: [this.registry],
  });

  // ── Outbox ─────────────────────────────────────────────────────────────────
  readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Outbox rows in PENDING state (undelivered side effects).',
    registers: [this.registry],
  });

  readonly outboxDispatched = new Counter({
    name: 'outbox_messages_dispatched_total',
    help: 'Outbox messages successfully delivered.',
    registers: [this.registry],
  });

  /**
   * A side effect that permanently gave up. This is the metric an alert should
   * fire on: it means an at-least-once guarantee was abandoned for a message.
   */
  readonly outboxFailed = new Counter({
    name: 'outbox_messages_failed_total',
    help: 'Outbox messages that exhausted attempts and went terminal (FAILED).',
    registers: [this.registry],
  });

  readonly outboxDispatchLatency = new Histogram({
    name: 'outbox_dispatch_latency_seconds',
    help: 'Latency of a single outbox dispatch attempt.',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  constructor() {
    // Standard process/node metrics (event loop lag, heap, GC, fds) on the same
    // registry so a single scrape covers app + runtime health.
    collectDefaultMetrics({ register: this.registry });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
