import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  /** Exhausted all attempts. Terminal; no longer polled. Raises an alert metric. */
  FAILED = 'FAILED',
}

/**
 * Transactional outbox (see ADR-0004). A row is written in the SAME transaction
 * as the state change that warrants the side effect, so a committed state change
 * can never exist without its pending notification, and a notification can never
 * be sent for a change that rolled back.
 *
 * The relay polls PENDING+due rows with FOR UPDATE SKIP LOCKED, dispatches, and
 * marks SENT (or reschedules with backoff). The partial index on (next_attempt_at)
 * WHERE status='PENDING' keeps that poll cheap and naturally excludes SENT/FAILED.
 */
@Entity('outbox_messages')
@Unique('uq_outbox_dedup', ['dedupKey'])
export class OutboxMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', name: 'aggregate_type' })
  aggregateType!: string;

  @Column({ type: 'uuid', name: 'aggregate_id' })
  aggregateId!: string;

  @Column({ type: 'text', name: 'event_type' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** When this row becomes eligible for (re)dispatch. Drives backoff. */
  @Column({
    type: 'timestamptz',
    name: 'next_attempt_at',
    default: () => 'now()',
  })
  nextAttemptAt!: Date;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  /**
   * Consumer-side idempotency token, sent with the dispatch so the downstream can
   * deduplicate our at-least-once deliveries. Derived deterministically and
   * collision-safe — `${aggregate_type}:${aggregate_id}:${event_type}:${version}`
   * — so two genuinely distinct side effects can never collide on it (which would
   * otherwise silently swallow one). See OutboxService.buildDedupKey.
   */
  @Column({ type: 'text', name: 'dedup_key' })
  dedupKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'dispatched_at', nullable: true })
  dispatchedAt!: Date | null;
}
