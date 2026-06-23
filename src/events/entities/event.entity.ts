import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The raw, immutable record of what was ingested at POST /events. We persist the
 * payload verbatim before doing anything else so the original is always
 * recoverable for audit/replay, independent of how it was later parsed into a
 * ticket. Nothing references events except the ticket derived from it
 * (one-directional dependency: idempotency -> ticket -> event).
 */
@Entity('events')
export class EventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The key this event was deduplicated under (mirrors idempotency_keys). */
  @Index()
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  /** Verbatim request body as received. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  source!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  receivedAt!: Date;
}
