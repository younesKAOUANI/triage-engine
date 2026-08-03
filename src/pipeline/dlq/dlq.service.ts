import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { MetricsService } from '../../observability/metrics.service';
import { PipelineJobData } from '../pipeline.constants';
import { PipelineProducer } from '../pipeline.producer';
import {
  DeadLetterEntity,
  DeadLetterStatus,
} from './entities/dead-letter.entity';

export interface ListDlqOptions {
  status?: DeadLetterStatus;
  limit: number;
  offset: number;
}

/**
 * Owns the durable dead-letter table (ADR-0007). It is written to by the worker's
 * terminal failure handler and read/acted-on via GET /dlq and POST /dlq/:id/replay.
 */
@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(
    @InjectRepository(DeadLetterEntity)
    private readonly repo: Repository<DeadLetterEntity>,
    private readonly producer: PipelineProducer,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Persist a dead letter once a job has exhausted its retries. Captures the full
   * error context plus the original job data verbatim, which is the source of
   * truth for replay.
   */
  async recordDeadLetter(
    job: Job<PipelineJobData>,
    error: Error,
  ): Promise<void> {
    const data = job.data;
    await this.repo.insert({
      queue: job.queueName,
      jobId: String(job.id),
      idempotencyKey: data.idempotencyKey,
      // jsonb column: cast past TypeORM's QueryDeepPartialEntity mapping.
      payload: data as unknown as Record<string, never>,
      errorMessage: error.message.slice(0, 2000),
      errorStack: error.stack ?? null,
      attemptsMade: job.attemptsMade,
      status: DeadLetterStatus.PENDING,
      failedAt: new Date(),
    });
    this.metrics.eventsFailed.inc({ disposition: 'dead_letter' });
    this.logger.error(
      {
        jobId: job.id,
        ticketId: data.ticketId,
        attempts: job.attemptsMade,
        err: error.message,
      },
      'job exhausted retries; dead-lettered',
    );
  }

  async list(options: ListDlqOptions): Promise<DeadLetterEntity[]> {
    return this.repo.find({
      where: options.status ? { status: options.status } : {},
      order: { failedAt: 'DESC' },
      take: options.limit,
      skip: options.offset,
    });
  }

  async getByIdOrThrow(id: string): Promise<DeadLetterEntity> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`dead letter ${id} not found`);
    }
    return row;
  }

  /**
   * Replay a dead letter back through the pipeline.
   *
   * Correctness hinges on two things working together:
   *  1) We flip PENDING -> REPLAYED atomically (conditional UPDATE ... RETURNING)
   *     BEFORE enqueueing, so two concurrent replays can't both fire. If the
   *     enqueue then throws, we revert to PENDING so it can be retried.
   *  2) The job re-enters through the original idempotency key, so the existing
   *     ticket is reused (no duplicate) and the outbox dedups the side effect.
   *     This is the DLQ ⇄ idempotency intersection that keeps the central
   *     invariant intact across a replay.
   */
  async replay(id: string): Promise<{ deadLetterId: string; jobId: string }> {
    // Atomically flip PENDING -> REPLAYED. We read UpdateResult.affected (not the
    // RETURNING array) because TypeORM's raw query() returns the misleading
    // [rows, affectedCount] shape for UPDATEs. result.raw still holds the row we
    // returned, which carries the original payload for re-enqueue.
    const flip = await this.repo
      .createQueryBuilder()
      .update(DeadLetterEntity)
      .set({ status: DeadLetterStatus.REPLAYED, replayedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('status = :pending', { pending: DeadLetterStatus.PENDING })
      .returning('*')
      .execute();
    if (!flip.affected) {
      // Either it doesn't exist or it was already replayed — distinguish for the API.
      const exists = await this.repo.findOne({ where: { id } });
      if (!exists) {
        throw new NotFoundException(`dead letter ${id} not found`);
      }
      throw new ConflictException(
        `dead letter ${id} has already been replayed`,
      );
    }

    const flippedRow = (flip.raw as Array<{ payload: unknown }>)[0];
    const data = flippedRow.payload as PipelineJobData;
    try {
      const jobId = await this.producer.enqueueReplay(data, id);
      this.logger.log(
        { deadLetterId: id, jobId, idempotencyKey: data.idempotencyKey },
        'dead letter replayed',
      );
      return { deadLetterId: id, jobId };
    } catch (error) {
      // Enqueue failed — undo the flip so the operator can try again.
      await this.repo.update(
        { id },
        { status: DeadLetterStatus.PENDING, replayedAt: null },
      );
      throw error;
    }
  }

  async pendingCount(): Promise<number> {
    return this.repo.count({ where: { status: DeadLetterStatus.PENDING } });
  }
}
