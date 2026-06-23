import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { IdempotencyStatus } from '../idempotency.enums';

/**
 * The idempotency ledger. The UNIQUE constraint on idempotency_key is the actual
 * concurrency guard — two simultaneous identical requests both try to INSERT, the
 * database lets exactly one win, and the loser reads the winner's row. No
 * application-level lock is involved. See ADR-0001.
 *
 * Retention note: rows are kept indefinitely in this reference implementation.
 * In production you would reap COMPLETED rows older than the client's retry
 * window (and surface that as a job/metric) — see README "Limitations".
 */
@Entity('idempotency_keys')
@Unique('uq_idempotency_key', ['idempotencyKey'])
export class IdempotencyKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Client-provided or server-derived. The dedup identity. */
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  /**
   * SHA-256 of the canonical request body. Lets us detect the dangerous case of
   * the same key being reused with a *different* payload (answered with 409).
   */
  @Column({ type: 'text', name: 'request_hash' })
  requestHash!: string;

  @Column({
    type: 'enum',
    enum: IdempotencyStatus,
    default: IdempotencyStatus.PENDING,
  })
  status!: IdempotencyStatus;

  /** The resource produced by this request, once known. */
  @Column({ type: 'uuid', name: 'ticket_id', nullable: true })
  ticketId!: string | null;

  /** Stored response for exact replay of a COMPLETED request. */
  @Column({ type: 'int', name: 'response_code', nullable: true })
  responseCode!: number | null;

  @Column({ type: 'jsonb', name: 'response_body', nullable: true })
  responseBody!: Record<string, unknown> | null;

  /** Lease timestamp; a stale lease on a PENDING row means it may be re-driven. */
  @Column({ type: 'timestamptz', name: 'locked_at', nullable: true })
  lockedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
