import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EventEntity } from '../../events/entities/event.entity';
import {
  EnrichmentSource,
  EnrichmentStatus,
  TicketCategory,
  TicketPriority,
} from '../ticket.enums';

/**
 * The domain aggregate derived from an event. Carries both the parsed ticket
 * fields and the mutable enrichment state. Enrichment results live here (rather
 * than a separate table) because there is exactly one current classification per
 * ticket and GET /tickets/:id returns them together.
 */
@Entity('tickets')
export class TicketEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The originating raw event. One-directional: ticket -> event. */
  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  // ── Parsed ticket content ──────────────────────────────────────────────────
  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', name: 'requester_email', nullable: true })
  requesterEmail!: string | null;

  // ── Enrichment state ───────────────────────────────────────────────────────
  @Index()
  @Column({
    type: 'enum',
    enum: EnrichmentStatus,
    name: 'enrichment_status',
    default: EnrichmentStatus.PENDING,
  })
  enrichmentStatus!: EnrichmentStatus;

  @Column({ type: 'enum', enum: TicketCategory, nullable: true })
  category!: TicketCategory | null;

  @Column({ type: 'enum', enum: TicketPriority, nullable: true })
  priority!: TicketPriority | null;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  /** Classifier confidence in [0,1]. */
  @Column({ type: 'real', nullable: true })
  confidence!: number | null;

  @Column({
    type: 'enum',
    enum: EnrichmentSource,
    name: 'enrichment_source',
    nullable: true,
  })
  enrichmentSource!: EnrichmentSource | null;

  /** Number of enrichment attempts made (used to cap retries). */
  @Column({ type: 'int', name: 'enrichment_attempts', default: 0 })
  enrichmentAttempts!: number;

  @Column({ type: 'timestamptz', name: 'enriched_at', nullable: true })
  enrichedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
