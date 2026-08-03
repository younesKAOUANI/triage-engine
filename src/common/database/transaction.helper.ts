import { DataSource, EntityManager, QueryRunner } from 'typeorm';

export type IsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Run `work` inside a single database transaction with the connect / commit /
 * rollback / release lifecycle handled exactly once, in one place.
 *
 * This exists deliberately. TypeORM's QueryRunner is the classic footgun: forget
 * `release()` in a `finally` and you leak a pooled connection on every error path
 * until the pool is exhausted and the app wedges. By funnelling every manual
 * transaction through this helper, no call site ever owns that lifecycle — they
 * just describe the work. The raw `queryRunner` is still handed to `work` for the
 * cases that need `FOR UPDATE SKIP LOCKED` and other lock-aware raw SQL.
 */
export async function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager, queryRunner: QueryRunner) => Promise<T>,
  isolation?: IsolationLevel,
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction(isolation);
  try {
    const result = await work(queryRunner.manager, queryRunner);
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}
