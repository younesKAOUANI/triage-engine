import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';
import { DlqService } from './dlq/dlq.service';
import { PipelineProducer } from './pipeline.producer';

/** How often to refresh the queue/DLQ depth gauges. */
const COLLECT_INTERVAL_MS = 5000;

/**
 * Periodically samples queue and DLQ depth into Prometheus gauges. These are the
 * "where is work piling up unseen?" signals — a growing waiting count or DLQ
 * depth is the earliest indicator that the pipeline is falling behind or
 * systematically failing. Best-effort: a sampling error is logged, not fatal.
 */
@Injectable()
export class PipelineObserver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineObserver.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly producer: PipelineProducer,
    private readonly dlq: DlqService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.collect(), COLLECT_INTERVAL_MS);
    // Don't keep the process alive solely for metrics sampling.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async collect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const counts = await this.producer.getJobCounts();
      this.metrics.queueDepth.set({ state: 'waiting' }, counts.waiting ?? 0);
      this.metrics.queueDepth.set({ state: 'active' }, counts.active ?? 0);
      this.metrics.queueDepth.set({ state: 'delayed' }, counts.delayed ?? 0);
      this.metrics.queueDepth.set({ state: 'failed' }, counts.failed ?? 0);
      this.metrics.dlqDepth.set(await this.dlq.pendingCount());
    } catch (error) {
      this.logger.debug({ err: error }, 'queue depth sampling failed');
    }
  }
}
