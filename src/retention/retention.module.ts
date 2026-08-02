import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { MetricsModule } from '../observability/metrics.module';
import { RetentionSweeper } from './retention.sweeper';

@Module({
  imports: [AppConfigModule, MetricsModule],
  providers: [RetentionSweeper],
  exports: [RetentionSweeper],
})
export class RetentionModule {}
