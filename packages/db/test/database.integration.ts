import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { applyMigrations } from "../src/migration-runner.ts";
import { IdempotencyConflictError, reserveIdempotencyKey, withTenantTransaction, writeWithAuditAndOutbox } from "../src/transactions.ts";

function environmentValue(name: string): string | undefined {
  return process.env[name];
}

async function localDatabaseUrl(): Promise<string> {
  const configured = environmentValue("DATABASE_URL");
  if (configured) return configured;
  const text = await readFile(new URL("../../../infra/env/.env.local", import.meta.url), "utf8");
  const variables = new Map(text.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
  const value = variables.get("DATABASE_URL");
  if (!value) throw new Error("DATABASE_URL is required; generate infra/env/.env.local or set it explicitly.");
  return value;
}

function testDatabaseUrl(url: string, database: string, user?: string, password?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return parsed.toString();
}

async function scalar(client: Sql<{}> | TransactionSql, query: ReturnType<Sql<{}>>): Promise<number> {
  const rows = await query;
  return Number((rows[0] as unknown as { count: string }).count);
}

const databaseName = `el_a02_${randomUUID().replaceAll("-", "")}`;
const applicationRole = `el_app_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const applicationPassword = randomBytes(24).toString("hex");
let admin: Sql<{}>;
let application: Sql<{}>;
let organizationA: string;
let organizationB: string;
let userA: string;
let userB: string;
let courseA: string;
let migrationDirectory: string;

async function appTransaction<T>(organizationId: string, operation: (transaction: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTransaction(application, { organizationId, actorId: null, correlationId: randomUUID() }, operation);
}

test.before(async () => {
  const baseUrl = await localDatabaseUrl();
  admin = postgres(baseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  const isolatedUrl = testDatabaseUrl(baseUrl, databaseName);
  const migrator = postgres(isolatedUrl, { max: 2, prepare: false });

  migrationDirectory = await mkdtemp(join(tmpdir(), "evidence-loop-a02-migrations-"));
  await writeFile(join(migrationDirectory, "2_create_probe.sql"), "CREATE TABLE migration_order_probe (id integer PRIMARY KEY);\n");
  await writeFile(join(migrationDirectory, "10_insert_probe.sql"), "INSERT INTO migration_order_probe (id) VALUES (1);\n");
  const numericOrder = await applyMigrations(migrator, migrationDirectory);
  assert.deepEqual(numericOrder.applied, ["2_create_probe.sql", "10_insert_probe.sql"]);
  await writeFile(join(migrationDirectory, "2_create_probe.sql"), "CREATE TABLE migration_order_probe (id integer PRIMARY KEY, changed boolean);\n");
  await assert.rejects(() => applyMigrations(migrator, migrationDirectory), /Migration checksum mismatch: 2_create_probe.sql/);

  const concurrentA = postgres(isolatedUrl, { max: 1, prepare: false });
  const concurrentB = postgres(isolatedUrl, { max: 1, prepare: false });
  try {
    const concurrent = await Promise.all([applyMigrations(concurrentA), applyMigrations(concurrentB)]);
    assert.equal(concurrent.filter((result) => result.applied.includes("0001_database_kernel.sql")).length, 1);
    assert.equal(concurrent.filter((result) => result.skipped.includes("0001_database_kernel.sql")).length, 1);
  } finally {
    await concurrentA.end({ timeout: 2 });
    await concurrentB.end({ timeout: 2 });
  }
  const rerun = await applyMigrations(migrator);
  assert.deepEqual(rerun.applied, []);
  assert.deepEqual(rerun.skipped, ["0001_database_kernel.sql"]);

  await migrator.unsafe(`CREATE ROLE ${applicationRole} LOGIN PASSWORD '${applicationPassword}' NOINHERIT`);
  await migrator.unsafe(`GRANT USAGE ON SCHEMA public TO ${applicationRole}`);
  await migrator.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${applicationRole}`);
  application = postgres(testDatabaseUrl(baseUrl, databaseName, applicationRole, applicationPassword), { max: 4, prepare: false });

  organizationA = randomUUID();
  organizationB = randomUUID();
  userA = randomUUID();
  userB = randomUUID();
  courseA = randomUUID();
  await migrator`
    INSERT INTO organizations (id, slug, display_name) VALUES
      (${organizationA}, 'tenant-a', 'Tenant A'), (${organizationB}, 'tenant-b', 'Tenant B')`;
  await migrator`
    INSERT INTO internal_users (id, organization_id, subject) VALUES
      (${userA}, ${organizationA}, 'synthetic-user-a'), (${userB}, ${organizationB}, 'synthetic-user-b')`;
  await migrator`INSERT INTO courses (id, organization_id, code, title) VALUES (${courseA}, ${organizationA}, 'A02', 'Synthetic course')`;
  await assert.rejects(
    () => migrator`INSERT INTO audit_events (organization_id, actor_id, correlation_id, action, target_type, target_id) VALUES (${organizationA}, ${userB}, ${randomUUID()}, 'invalid.actor', 'course', ${courseA})`,
    /audit_events_actor_id_organization_id_fkey/,
  );
  await assert.rejects(
    () => migrator`INSERT INTO organizations (slug, display_name) VALUES ('NOT-LOWERCASE', 'Invalid')`,
    /organizations_slug_check/,
  );
  await migrator.end({ timeout: 2 });
});

test.after(async () => {
  await application?.end({ timeout: 2 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.end({ timeout: 2 });
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("RLS fails closed without context and denies cross-tenant reads and writes", async () => {
  await application.begin(async (transaction) => {
    const missing = await transaction`SELECT id FROM courses`;
    assert.equal(missing.length, 0);
  });

  await appTransaction(organizationA, async (transaction) => {
    const own = await transaction`SELECT id FROM courses`;
    assert.deepEqual(own.map((row) => row.id), [courseA]);
  });

  await appTransaction(organizationB, async (transaction) => {
    const foreign = await transaction`SELECT id FROM courses`;
    assert.equal(foreign.length, 0);
    const update = await transaction`UPDATE courses SET title = 'cross-tenant' WHERE id = ${courseA} RETURNING id`;
    assert.equal(update.length, 0);
  });
});

test("audit events are append-only under the application role", async () => {
  const auditId = randomUUID();
  await appTransaction(organizationA, async (transaction) => {
    await transaction`
      INSERT INTO audit_events (id, organization_id, actor_id, correlation_id, action, target_type, target_id)
      VALUES (${auditId}, ${organizationA}, ${userA}, ${randomUUID()}, 'course.created', 'course', ${courseA})`;
  });
  await assert.rejects(
    () => appTransaction(organizationA, async (transaction) => transaction`UPDATE audit_events SET action = 'tampered' WHERE id = ${auditId}`),
    /append-only/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, async (transaction) => transaction`DELETE FROM audit_events WHERE id = ${auditId}`),
    /append-only/,
  );
});

test("idempotency keys replay only an identical fingerprint, including concurrent retries", async () => {
  const key = `key-${randomUUID()}`;
  const fingerprint = "a".repeat(64);
  await appTransaction(organizationA, async (transaction) => {
    assert.equal(await reserveIdempotencyKey(transaction, { organizationId: organizationA, operation: "course.create", key, requestFingerprint: fingerprint }), "created");
    assert.equal(await reserveIdempotencyKey(transaction, { organizationId: organizationA, operation: "course.create", key, requestFingerprint: fingerprint }), "replayed");
    await assert.rejects(
      () => reserveIdempotencyKey(transaction, { organizationId: organizationA, operation: "course.create", key, requestFingerprint: "b".repeat(64) }),
      IdempotencyConflictError,
    );
  });

  const concurrentKey = `key-${randomUUID()}`;
  const results = await Promise.all([
    appTransaction(organizationA, (transaction) => reserveIdempotencyKey(transaction, { organizationId: organizationA, operation: "course.create", key: concurrentKey, requestFingerprint: fingerprint })),
    appTransaction(organizationA, (transaction) => reserveIdempotencyKey(transaction, { organizationId: organizationA, operation: "course.create", key: concurrentKey, requestFingerprint: fingerprint })),
  ]);
  assert.deepEqual(results.sort(), ["created", "replayed"]);
});

test("domain, audit, and outbox writes roll back together, including rejected audit metadata", async () => {
  const courseId = randomUUID();
  await assert.rejects(() => appTransaction(organizationA, async (transaction) => {
    await writeWithAuditAndOutbox(transaction, {
      organizationId: organizationA,
      actorId: userA,
      correlationId: randomUUID(),
      audit: { action: "course.created", targetType: "course", targetId: courseId },
      outbox: { aggregateType: "course", aggregateId: courseId, topic: "course.created", payload: { synthetic: true } },
      domainWrite: async (domainTransaction: TransactionSql) => {
        await domainTransaction`INSERT INTO courses (id, organization_id, code, title) VALUES (${courseId}, ${organizationA}, 'ROLLBACK', 'Will roll back')`;
        throw new Error("intentional rollback");
      },
    });
  }), /intentional rollback/);

  let domainWriteRan = false;
  await assert.rejects(() => appTransaction(organizationA, async (transaction) => writeWithAuditAndOutbox(transaction, {
    organizationId: organizationA,
    actorId: userA,
    correlationId: randomUUID(),
    audit: { action: "course.created", targetType: "course", targetId: courseId, metadata: { reason: { rawTranscript: "learner answer" } } },
    outbox: { aggregateType: "course", aggregateId: courseId, topic: "course.created", payload: { synthetic: true } },
    domainWrite: async () => {
      domainWriteRan = true;
      return undefined;
    },
  })), /enum-value-not-allowed/);
  assert.equal(domainWriteRan, false);

  await appTransaction(organizationA, async (transaction) => {
    assert.equal(await scalar(transaction, transaction`SELECT count(*) FROM courses WHERE id = ${courseId}`), 0);
    assert.equal(await scalar(transaction, transaction`SELECT count(*) FROM audit_events WHERE target_id = ${courseId}`), 0);
    assert.equal(await scalar(transaction, transaction`SELECT count(*) FROM outbox_events WHERE aggregate_id = ${courseId}`), 0);
  });
});
