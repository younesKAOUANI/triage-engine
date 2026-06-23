import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema. Hand-written (not generated) so the ordering, constraints, and
 * the partial outbox index are explicit and reviewable.
 *
 * Table/FK creation order encodes the deliberate one-directional dependency:
 *   events  <--  tickets  <--  idempotency_keys
 * Nothing points back the other way, so there is no FK cycle and the migration
 * (and any teardown) has a clean topological order.
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // gen_random_uuid() is core in PG13+, but make the dependency explicit/safe.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── Enum types ─────────────────────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "tickets_enrichment_status_enum" AS ENUM ('PENDING','ENRICHED','DEGRADED','FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "tickets_category_enum" AS ENUM ('BILLING','TECHNICAL','ACCOUNT','FEATURE_REQUEST','COMPLAINT','OTHER')`,
    );
    await queryRunner.query(
      `CREATE TYPE "tickets_priority_enum" AS ENUM ('LOW','MEDIUM','HIGH','URGENT')`,
    );
    await queryRunner.query(
      `CREATE TYPE "tickets_enrichment_source_enum" AS ENUM ('AI','FALLBACK')`,
    );
    await queryRunner.query(
      `CREATE TYPE "idempotency_keys_status_enum" AS ENUM ('PENDING','COMPLETED','FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "outbox_messages_status_enum" AS ENUM ('PENDING','SENT','FAILED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "dead_letters_status_enum" AS ENUM ('PENDING','REPLAYED')`,
    );

    // ── events ─────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "events" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "idempotency_key" text NOT NULL,
        "payload"         jsonb NOT NULL,
        "source"          text,
        "received_at"     timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_events_idempotency_key" ON "events" ("idempotency_key")`,
    );

    // ── tickets ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "tickets" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_id"            uuid NOT NULL,
        "subject"             text NOT NULL,
        "body"                text NOT NULL,
        "requester_email"     text,
        "enrichment_status"   "tickets_enrichment_status_enum" NOT NULL DEFAULT 'PENDING',
        "category"            "tickets_category_enum",
        "priority"            "tickets_priority_enum",
        "summary"             text,
        "confidence"          real,
        "enrichment_source"   "tickets_enrichment_source_enum",
        "enrichment_attempts" integer NOT NULL DEFAULT 0,
        "enriched_at"         timestamptz,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_tickets_event" FOREIGN KEY ("event_id")
          REFERENCES "events" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_tickets_event_id" ON "tickets" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_tickets_enrichment_status" ON "tickets" ("enrichment_status")`,
    );

    // ── idempotency_keys ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "idempotency_key" text NOT NULL,
        "request_hash"    text NOT NULL,
        "status"          "idempotency_keys_status_enum" NOT NULL DEFAULT 'PENDING',
        "ticket_id"       uuid,
        "response_code"   integer,
        "response_body"   jsonb,
        "locked_at"       timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "fk_idempotency_ticket" FOREIGN KEY ("ticket_id")
          REFERENCES "tickets" ("id") ON DELETE SET NULL
      )
    `);
    // Supports the lease-reclaim sweep over stale PENDING rows.
    await queryRunner.query(
      `CREATE INDEX "ix_idempotency_status" ON "idempotency_keys" ("status")`,
    );

    // ── outbox_messages ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "outbox_messages" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "aggregate_type"  text NOT NULL,
        "aggregate_id"    uuid NOT NULL,
        "event_type"      text NOT NULL,
        "payload"         jsonb NOT NULL,
        "status"          "outbox_messages_status_enum" NOT NULL DEFAULT 'PENDING',
        "attempts"        integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "last_error"      text,
        "dedup_key"       text NOT NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "dispatched_at"   timestamptz,
        CONSTRAINT "uq_outbox_dedup" UNIQUE ("dedup_key")
      )
    `);
    // Partial index: the relay only ever scans PENDING+due rows, so the index is
    // kept small and SENT/FAILED rows fall out of it automatically.
    await queryRunner.query(
      `CREATE INDEX "ix_outbox_due" ON "outbox_messages" ("next_attempt_at") WHERE "status" = 'PENDING'`,
    );

    // ── dead_letters ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "dead_letters" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "queue"           text NOT NULL,
        "job_id"          text NOT NULL,
        "idempotency_key" text NOT NULL,
        "payload"         jsonb NOT NULL,
        "error_message"   text NOT NULL,
        "error_stack"     text,
        "attempts_made"   integer NOT NULL,
        "status"          "dead_letters_status_enum" NOT NULL DEFAULT 'PENDING',
        "failed_at"       timestamptz NOT NULL,
        "replayed_at"     timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_dead_letters_status" ON "dead_letters" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_dead_letters_idempotency_key" ON "dead_letters" ("idempotency_key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "dead_letters"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tickets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "events"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "dead_letters_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "outbox_messages_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "idempotency_keys_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tickets_enrichment_source_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tickets_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tickets_category_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tickets_enrichment_status_enum"`);
  }
}
