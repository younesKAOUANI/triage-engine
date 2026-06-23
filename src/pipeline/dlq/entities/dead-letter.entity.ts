import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum DeadLetterStatus {
  PENDING = 'PENDING',
  REPLAYED = 'REPLAYED',
}

/**
 * Durable dead-letter record (see ADR-0007). Written by the worker's final
 * `failed` handler once a job has exhausted its BullMQ retries. We keep our own
 * table rather than leaning on BullMQ's failed set because this is the
 * operational surface: it's queryable (GET /dlq), carries full error context for
 * triage, and survives Redis being flushed.
 *
 * `payload` is the original job data verbatim — crucially including the
 * idempotency key — so a replay re-enters the pipeline through the SAME key and
 * cannot create a duplicate ticket (see DlqService.replay and ADR-0001/0007).
 */
@Entity('dead_letters')
export class DeadLetterEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  queue!: string;

  /** Original BullMQ job id, for cross-referencing logs/Redis. */
  @Column({ type: 'text', name: 'job_id' })
  jobId!: string;

  @Index()
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  /** The full job data, used as the source of truth for replay. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', name: 'error_message' })
  errorMessage!: string;

  @Column({ type: 'text', name: 'error_stack', nullable: true })
  errorStack!: string | null;

  @Column({ type: 'int', name: 'attempts_made' })
  attemptsMade!: number;

  @Index()
  @Column({
    type: 'enum',
    enum: DeadLetterStatus,
    default: DeadLetterStatus.PENDING,
  })
  status!: DeadLetterStatus;

  @Column({ type: 'timestamptz', name: 'failed_at' })
  failedAt!: Date;

  @Column({ type: 'timestamptz', name: 'replayed_at', nullable: true })
  replayedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
