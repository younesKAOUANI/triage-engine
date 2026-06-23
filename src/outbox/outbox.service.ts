import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface EmitInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /**
   * Distinguishes successive side effects for the same aggregate+event so their
   * dedup keys don't collide. Use a state version, attempt number, or any
   * monotonic discriminator. Two genuinely distinct side effects MUST differ here.
   */
  version: string | number;
  payload: Record<string, unknown>;
}

/**
 * Writes side effects into the outbox (ADR-0004). The single public method takes
 * an EntityManager on purpose: the caller passes the manager of the transaction
 * that is making the state change, so the outbox row and the state change commit
 * (or roll back) together. There is intentionally no "emit outside a transaction"
 * method — that would defeat the pattern.
 */
@Injectable()
export class OutboxService {
  /**
   * Collision-safe, deterministic dedup key. Because it's deterministic, emitting
   * the *same* logical side effect twice (e.g. a reprocessed job) lands on the
   * same key and is absorbed by ON CONFLICT DO NOTHING below — at-most-once
   * persistence of each intended effect. Because `version` is part of it, two
   * distinct effects can never accidentally share a key and silently drop one.
   */
  buildDedupKey(input: EmitInput): string {
    return `${input.aggregateType}:${input.aggregateId}:${input.eventType}:${input.version}`;
  }

  async emit(manager: EntityManager, input: EmitInput): Promise<string> {
    const dedupKey = this.buildDedupKey(input);
    await manager.query(
      `INSERT INTO outbox_messages
         (aggregate_type, aggregate_id, event_type, payload, dedup_key, status, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', now())
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        JSON.stringify(input.payload),
        dedupKey,
      ],
    );
    return dedupKey;
  }
}
