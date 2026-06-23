import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { APP_ENV } from '../config/app-config.module';
import { EnvVars } from '../config/env.validation';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity';
import { IdempotencyStatus } from './idempotency.enums';

/**
 * Outcome of trying to claim an idempotency key:
 *  - NEW:       caller won the race and owns processing for this key.
 *  - REPLAY:    a COMPLETED record exists — return its stored response, do no work.
 *  - IN_FLIGHT: a PENDING record exists with a fresh lease — another worker is on
 *               it; the caller should not duplicate the work.
 *  - CONFLICT:  the key was reused with a *different* payload (request_hash differs).
 */
export type ClaimResult =
  | { outcome: 'NEW' }
  | { outcome: 'REPLAY'; record: IdempotencyKeyEntity }
  | { outcome: 'IN_FLIGHT'; record: IdempotencyKeyEntity }
  | { outcome: 'CONFLICT'; record: IdempotencyKeyEntity };

/**
 * The idempotency state machine (ADR-0001). All concurrency safety comes from the
 * database, never from application locks:
 *  - The initial race is decided by `INSERT ... ON CONFLICT DO NOTHING` against
 *    the UNIQUE(idempotency_key) constraint — exactly one concurrent inserter wins.
 *  - Re-driving a crashed/failed key is decided by a conditional `UPDATE ...
 *    RETURNING` whose WHERE clause Postgres re-evaluates under the row lock, so
 *    two simultaneous reclaimers cannot both succeed.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyKeyEntity)
    private readonly repo: Repository<IdempotencyKeyEntity>,
    @Inject(APP_ENV) private readonly env: EnvVars,
  ) {}

  /**
   * Attempt to claim `key` for processing. See ClaimResult for the four outcomes.
   * Safe to call concurrently with itself for the same key.
   */
  async claim(key: string, requestHash: string): Promise<ClaimResult> {
    // 1) Try to win the key outright. orIgnore() => ON CONFLICT DO NOTHING against
    //    the UNIQUE(idempotency_key) constraint, so at most one of N concurrent
    //    callers gets a row back. We read InsertResult.raw (the RETURNING rows);
    //    on a conflict it is empty.
    const insertResult = await this.repo
      .createQueryBuilder()
      .insert()
      .into(IdempotencyKeyEntity)
      .values({
        idempotencyKey: key,
        requestHash,
        status: IdempotencyStatus.PENDING,
        lockedAt: () => 'now()',
      })
      .orIgnore()
      .returning('id')
      .execute();
    if ((insertResult.raw as unknown[]).length > 0) {
      return { outcome: 'NEW' };
    }

    // 2) Someone else owns the row. Read it to decide what to do.
    const existing = await this.repo.findOneByOrFail({ idempotencyKey: key });

    // Same key, different body: a real client bug we must surface, not paper over.
    if (existing.requestHash !== requestHash) {
      return { outcome: 'CONFLICT', record: existing };
    }

    if (existing.status === IdempotencyStatus.COMPLETED) {
      return { outcome: 'REPLAY', record: existing };
    }

    // 3) PENDING (maybe stale) or FAILED: try to reclaim it. FAILED is always
    //    reclaimable; PENDING only once its lease has expired (crashed worker).
    //    Postgres re-checks the WHERE under the row lock, so concurrent reclaimers
    //    serialise and only one wins.
    //
    //    We MUST read UpdateResult.affected, not the RETURNING array: TypeORM's
    //    raw query() returns the misleading shape [rows, affectedCount] for an
    //    UPDATE, so a length check there is always truthy. The typed result is
    //    unambiguous.
    const reclaim = await this.repo
      .createQueryBuilder()
      .update(IdempotencyKeyEntity)
      .set({
        status: IdempotencyStatus.PENDING,
        lockedAt: () => 'now()',
        updatedAt: () => 'now()',
      })
      .where('idempotency_key = :key', { key })
      .andWhere(
        `(status = 'FAILED'
          OR (status = 'PENDING'
              AND (locked_at IS NULL
                   OR locked_at < now() - (interval '1 millisecond' * :lease))))`,
        { lease: this.env.IDEMPOTENCY_LEASE_MS },
      )
      .execute();
    if ((reclaim.affected ?? 0) > 0) {
      // A genuine recovery event worth surfacing: a crashed/failed run was re-driven.
      this.logger.warn(
        { key },
        'reclaimed abandoned idempotency key (stale lease or prior failure)',
      );
      return { outcome: 'NEW' };
    }

    // Still actively PENDING within its lease — genuinely in flight elsewhere.
    return { outcome: 'IN_FLIGHT', record: existing };
  }

  /**
   * Lock the idempotency row for this key FOR UPDATE within an existing
   * transaction. Used by the ingestion path to serialise the "create the ticket
   * if it doesn't exist yet" step so a reclaim-driven re-run can never produce a
   * second ticket for the same key.
   */
  async lockForUpdate(
    manager: EntityManager,
    key: string,
  ): Promise<IdempotencyKeyEntity> {
    const rows: IdempotencyKeyEntity[] = await manager
      .createQueryBuilder(IdempotencyKeyEntity, 'k')
      .setLock('pessimistic_write')
      .where('k.idempotencyKey = :key', { key })
      .getMany();
    if (rows.length === 0) {
      throw new Error(`idempotency row vanished for key ${key}`);
    }
    return rows[0];
  }

  /** Attach the produced ticket to the key as soon as it exists (within `manager`). */
  async attachTicket(
    manager: EntityManager,
    key: string,
    ticketId: string,
  ): Promise<void> {
    await manager.update(
      IdempotencyKeyEntity,
      { idempotencyKey: key },
      { ticketId },
    );
  }

  /** Mark a key COMPLETED and store the response to replay on future duplicates. */
  async markCompleted(
    key: string,
    ticketId: string,
    responseCode: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.update(
      { idempotencyKey: key },
      {
        status: IdempotencyStatus.COMPLETED,
        ticketId,
        responseCode,
        // jsonb column: cast past TypeORM's QueryDeepPartialEntity mapping.
        responseBody: responseBody as Record<string, never>,
        lockedAt: null,
      },
    );
  }

  /** Mark a key FAILED so a later request (or replay) is allowed to re-drive it. */
  async markFailed(key: string): Promise<void> {
    await this.repo.update(
      { idempotencyKey: key },
      { status: IdempotencyStatus.FAILED, lockedAt: null },
    );
  }
}
