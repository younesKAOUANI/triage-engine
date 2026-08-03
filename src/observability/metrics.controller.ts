import { Controller, Get, Header, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_ALL } from '../common/rate-limit/rate-limit.module';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

// A throttled scrape looks like an outage to Prometheus.
@SkipThrottle(SKIP_ALL)
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus scrape endpoint. */
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }
}
