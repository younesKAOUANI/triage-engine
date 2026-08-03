import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WRITE_LIMIT } from '../../common/rate-limit/rate-limit.module';
import { DlqService } from './dlq.service';
import {
  DeadLetterEntity,
  DeadLetterStatus,
} from './entities/dead-letter.entity';

@Controller('dlq')
export class DlqController {
  constructor(private readonly dlq: DlqService) {}

  /** GET /dlq?status=PENDING&limit=50&offset=0 */
  @Get()
  async list(
    @Query('status', new ParseEnumPipe(DeadLetterStatus, { optional: true }))
    status: DeadLetterStatus | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    const rows = await this.dlq.list({
      status,
      limit: Math.min(limit, 200),
      offset,
    });
    return { count: rows.length, items: rows.map((r) => this.toView(r)) };
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.toView(await this.dlq.getByIdOrThrow(id));
  }

  /** POST /dlq/:id/replay — re-enqueue through the original idempotency key. */
  @Post(':id/replay')
  @HttpCode(202)
  @Throttle({ [WRITE_LIMIT]: {} })
  async replay(@Param('id', ParseUUIDPipe) id: string) {
    return this.dlq.replay(id);
  }

  private toView(r: DeadLetterEntity) {
    return {
      id: r.id,
      queue: r.queue,
      jobId: r.jobId,
      idempotencyKey: r.idempotencyKey,
      status: r.status,
      attemptsMade: r.attemptsMade,
      error: { message: r.errorMessage, stack: r.errorStack },
      payload: r.payload,
      failedAt: r.failedAt,
      replayedAt: r.replayedAt,
      createdAt: r.createdAt,
    };
  }
}
