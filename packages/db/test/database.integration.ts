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
  if (value) return value;
  const user = variables.get("POSTGRES_USER");
  const password = variables.get("POSTGRES_PASSWORD");
  const database = variables.get("POSTGRES_DB");
  const port = variables.get("POSTGRES_PORT") ?? "5432";
  if (!user || !password || !database) throw new Error("DATABASE_URL is required; generate infra/env/.env.local or set it explicitly.");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
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
const workerRole = `el_worker_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const workerPassword = randomBytes(24).toString("hex");
let admin: Sql<{}>;
let application: Sql<{}>;
let worker: Sql<{}>;
let organizationA: string;
let organizationB: string;
let userA: string;
let userB: string;
let courseA: string;
let migrationDirectory: string;

async function appTransaction<T>(organizationId: string, operation: (transaction: TransactionSql) => Promise<T>, actorId: string | null = null): Promise<T> {
  return withTenantTransaction(application, { organizationId, actorId, correlationId: randomUUID() }, operation);
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
    assert.equal(concurrent.filter((result) => result.applied.includes("0002_assessment_authoring.sql")).length, 1);
    assert.equal(concurrent.filter((result) => result.skipped.includes("0001_database_kernel.sql")).length, 1);
    assert.equal(concurrent.filter((result) => result.skipped.includes("0002_assessment_authoring.sql")).length, 1);
  } finally {
    await concurrentA.end({ timeout: 2 });
    await concurrentB.end({ timeout: 2 });
  }
  const rerun = await applyMigrations(migrator);
  assert.deepEqual(rerun.applied, []);
  assert.deepEqual(rerun.skipped, ["0001_database_kernel.sql", "0002_assessment_authoring.sql", "0003_artifact_pipeline.sql"]);

  await migrator.unsafe(`CREATE ROLE ${applicationRole} LOGIN PASSWORD '${applicationPassword}' NOINHERIT NOBYPASSRLS`);
  await migrator.unsafe(`CREATE ROLE ${workerRole} LOGIN PASSWORD '${workerPassword}' NOINHERIT NOBYPASSRLS`);
  await migrator.unsafe(`GRANT CONNECT ON DATABASE ${databaseName} TO ${applicationRole}, ${workerRole}`);
  await migrator.unsafe(`GRANT USAGE ON SCHEMA public TO ${applicationRole}, ${workerRole}`);
  await migrator.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${applicationRole}`);
  await migrator.unsafe(`GRANT EXECUTE ON FUNCTION complete_artifact_upload(uuid, uuid, uuid, uuid, text, text, text) TO ${applicationRole}`);
  await migrator.unsafe(`GRANT EXECUTE ON FUNCTION claim_artifact_outbox(text, integer), finish_artifact_outbox(uuid, text, boolean, text), load_claimed_artifact(uuid, text), terminal_claimed_artifact(uuid, text, text, text, text), claim_stale_artifact_upload_intents(text, integer), finish_stale_artifact_upload_intent(uuid, text, boolean, integer, text) TO ${workerRole}`);
  application = postgres(testDatabaseUrl(baseUrl, databaseName, applicationRole, applicationPassword), { max: 4, prepare: false });
  worker = postgres(testDatabaseUrl(baseUrl, databaseName, workerRole, workerPassword), { max: 2, prepare: false });

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
  await migrator`INSERT INTO course_memberships (organization_id, course_id, user_id, role) VALUES (${organizationA}, ${courseA}, ${userA}, 'learner')`;
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
  await worker?.end({ timeout: 2 });
  await application?.end({ timeout: 2 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.end({ timeout: 2 });
  if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
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

test("published assessment snapshot children cannot be reparented into a draft", async () => {
  const assessmentId = randomUUID();
  const publishedVersionId = randomUUID();
  const draftVersionId = randomUUID();
  const publishedObjectiveId = randomUUID();
  const draftObjectiveId = randomUUID();
  const publishedCriterionId = randomUUID();
  const draftCriterionId = randomUUID();

  await appTransaction(organizationA, async (transaction) => {
    await transaction`
      INSERT INTO assessments (id, organization_id, course_id, title)
      VALUES (${assessmentId}, ${organizationA}, ${courseA}, 'Snapshot assessment')`;
    await transaction`
      INSERT INTO assessment_versions (
        id, organization_id, course_id, assessment_id, version_number, title,
        assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary,
        completion_criteria, text_check_in, voice_check_in, extra_time,
        pause_and_resume, alternative_assessment_request, question_budget,
        time_budget_minutes, created_by
      ) VALUES (
        ${publishedVersionId}, ${organizationA}, ${courseA}, ${assessmentId}, 1, 'Published snapshot',
        'Synthetic instructions.', 'Synthetic policy.', 'allowed', 'Synthetic privacy.',
        'Synthetic completion.', true, false, false, true, true, 3, 3, ${userA}
      )`;
    await transaction`
      INSERT INTO assessment_objectives (
        id, organization_id, assessment_id, assessment_version_id, position,
        label, description, evidence_criteria, assessable_in_check_in, approved_by
      ) VALUES (
        ${publishedObjectiveId}, ${organizationA}, ${assessmentId}, ${publishedVersionId}, 1,
        'Published objective', 'Synthetic description.', 'Synthetic evidence.', true, ${userA}
      )`;
    await transaction`
      INSERT INTO rubric_criteria (
        id, organization_id, assessment_id, assessment_version_id, position,
        label, description, evidence_criteria
      ) VALUES (
        ${publishedCriterionId}, ${organizationA}, ${assessmentId}, ${publishedVersionId}, 1,
        'Published criterion', 'Synthetic description.', 'Synthetic evidence.'
      )`;
    await transaction`
      INSERT INTO rubric_criterion_objectives (
        organization_id, assessment_version_id, criterion_id, objective_id
      ) VALUES (${organizationA}, ${publishedVersionId}, ${publishedCriterionId}, ${publishedObjectiveId})`;
    await transaction`
      UPDATE assessment_versions
      SET state = 'published', published_by = ${userA}, published_at = now()
      WHERE id = ${publishedVersionId}`;
    await transaction`
      UPDATE assessments
      SET state = 'published', current_published_version_id = ${publishedVersionId}
      WHERE id = ${assessmentId}`;

    await transaction`
      INSERT INTO assessment_versions (
        id, organization_id, course_id, assessment_id, version_number, title,
        assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary,
        completion_criteria, text_check_in, voice_check_in, extra_time,
        pause_and_resume, alternative_assessment_request, question_budget,
        time_budget_minutes, created_by
      ) VALUES (
        ${draftVersionId}, ${organizationA}, ${courseA}, ${assessmentId}, 2, 'Mutable draft',
        'Synthetic instructions.', 'Synthetic policy.', 'allowed', 'Synthetic privacy.',
        'Synthetic completion.', true, false, false, true, true, 3, 3, ${userA}
      )`;
    await transaction`
      INSERT INTO assessment_objectives (
        id, organization_id, assessment_id, assessment_version_id, position,
        label, description, evidence_criteria, assessable_in_check_in, approved_by
      ) VALUES (
        ${draftObjectiveId}, ${organizationA}, ${assessmentId}, ${draftVersionId}, 1,
        'Draft objective', 'Synthetic description.', 'Synthetic evidence.', true, ${userA}
      )`;
    await transaction`
      INSERT INTO rubric_criteria (
        id, organization_id, assessment_id, assessment_version_id, position,
        label, description, evidence_criteria
      ) VALUES (
        ${draftCriterionId}, ${organizationA}, ${assessmentId}, ${draftVersionId}, 1,
        'Draft criterion', 'Synthetic description.', 'Synthetic evidence.'
      )`;
  });

  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`
      UPDATE assessment_objectives
      SET assessment_version_id = ${draftVersionId}
      WHERE id = ${publishedObjectiveId}`),
    /assessment version parent is immutable/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`
      UPDATE rubric_criteria
      SET assessment_version_id = ${draftVersionId}
      WHERE id = ${publishedCriterionId}`),
    /assessment version parent is immutable/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`
      UPDATE rubric_criterion_objectives
      SET assessment_version_id = ${draftVersionId}, criterion_id = ${draftCriterionId}, objective_id = ${draftObjectiveId}
      WHERE assessment_version_id = ${publishedVersionId}
        AND criterion_id = ${publishedCriterionId}
        AND objective_id = ${publishedObjectiveId}`),
    /assessment version parent is immutable/,
  );

  await appTransaction(organizationA, async (transaction) => {
    const objective = await transaction<{ assessment_version_id: string; label: string }[]>`
      SELECT assessment_version_id, label FROM assessment_objectives WHERE id = ${publishedObjectiveId}`;
    const criterion = await transaction<{ assessment_version_id: string; label: string }[]>`
      SELECT assessment_version_id, label FROM rubric_criteria WHERE id = ${publishedCriterionId}`;
    const mapping = await transaction<{ assessment_version_id: string; criterion_id: string; objective_id: string }[]>`
      SELECT assessment_version_id, criterion_id, objective_id
      FROM rubric_criterion_objectives
      WHERE assessment_version_id = ${publishedVersionId}
        AND criterion_id = ${publishedCriterionId}
        AND objective_id = ${publishedObjectiveId}`;
    assert.deepEqual(Array.from(objective), [{ assessment_version_id: publishedVersionId, label: 'Published objective' }]);
    assert.deepEqual(Array.from(criterion), [{ assessment_version_id: publishedVersionId, label: 'Published criterion' }]);
    assert.deepEqual(Array.from(mapping), [{ assessment_version_id: publishedVersionId, criterion_id: publishedCriterionId, objective_id: publishedObjectiveId }]);
  });
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

test("B04 RLS exposes artifacts only to the owner or scoped staff", async () => {
  const otherLearner = randomUUID();
  const otherCourseLearner = randomUUID();
  const staff = randomUUID();
  const otherCourse = randomUUID();
  const assessment = randomUUID();
  const version = randomUUID();
  const submission = randomUUID();
  const artifact = randomUUID();

  await appTransaction(organizationA, async (transaction) => {
    await transaction`INSERT INTO internal_users (id, organization_id, subject) VALUES (${otherLearner}, ${organizationA}, 'same-course-learner'), (${otherCourseLearner}, ${organizationA}, 'other-course-learner'), (${staff}, ${organizationA}, 'scoped-staff')`;
    await transaction`INSERT INTO courses (id, organization_id, code, title) VALUES (${otherCourse}, ${organizationA}, 'B04-OTHER', 'Other synthetic course')`;
    await transaction`INSERT INTO course_memberships (organization_id, course_id, user_id, role) VALUES (${organizationA}, ${courseA}, ${otherLearner}, 'learner'), (${organizationA}, ${courseA}, ${staff}, 'teaching_assistant'), (${organizationA}, ${otherCourse}, ${otherCourseLearner}, 'learner')`;
    await transaction`INSERT INTO assessments (id, organization_id, course_id, title) VALUES (${assessment}, ${organizationA}, ${courseA}, 'B04 scoped assessment')`;
    await transaction`INSERT INTO assessment_versions (id, organization_id, course_id, assessment_id, version_number, title, assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary, completion_criteria, text_check_in, voice_check_in, extra_time, pause_and_resume, alternative_assessment_request, question_budget, time_budget_minutes, created_by) VALUES (${version}, ${organizationA}, ${courseA}, ${assessment}, 1, 'B04 version', 'Synthetic instructions.', 'Synthetic policy.', 'allowed', 'Synthetic privacy.', 'Synthetic completion.', true, false, false, true, true, 3, 3, ${userA})`;
    await transaction`UPDATE assessment_versions SET state='published', published_by=${userA}, published_at=now() WHERE id=${version}`;
    await transaction`UPDATE assessments SET state='published', current_published_version_id=${version} WHERE id=${assessment}`;
    await transaction`INSERT INTO submissions (id, organization_id, course_id, assessment_id, assessment_version_id, learner_id) VALUES (${submission}, ${organizationA}, ${courseA}, ${assessment}, ${version}, ${userA})`;
    await transaction`INSERT INTO artifacts (id, organization_id, submission_id, quarantine_key, declared_extension, declared_content_type, byte_size, sha256) VALUES (${artifact}, ${organizationA}, ${submission}, 'q/scoped-artifact', '.txt', 'text/plain', 1, ${"a".repeat(64)})`;
  }, userA);

  await appTransaction(organizationA, async (transaction) => {
    assert.equal((await transaction`SELECT id FROM artifacts WHERE id=${artifact}`).length, 0);
  }, otherLearner);
  await appTransaction(organizationA, async (transaction) => {
    assert.equal((await transaction`SELECT id FROM artifacts WHERE id=${artifact}`).length, 0);
  }, otherCourseLearner);
  await appTransaction(organizationA, async (transaction) => {
    assert.deepEqual((await transaction`SELECT id FROM artifacts WHERE id=${artifact}`).map((row) => row.id), [artifact]);
  }, staff);
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`UPDATE artifacts SET sha256=${"b".repeat(64)} WHERE id=${artifact}`, userA),
    /artifact identity is immutable/,
  );

  const intent = randomUUID();
  const fragment = randomUUID();
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`INSERT INTO artifact_fragments (id, organization_id, submission_id, artifact_id, ordinal, locator, content_type, content, content_hash, parser_version) VALUES (${fragment}, ${organizationA}, ${submission}, ${artifact}, 0, ${transaction.json({ line_start: 1, line_end: 1 })}, 'text', 'pre-clean', ${"d".repeat(64)}, 'test')`, userA),
    /artifact fragments are lifecycle-managed/,
  );
  await appTransaction(organizationA, async (transaction) => {
    await transaction`INSERT INTO artifact_upload_intents (id, organization_id, submission_id, artifact_id, actor_id, token_digest, expected_byte_size, expected_sha256, expires_at) VALUES (${intent}, ${organizationA}, ${submission}, ${artifact}, ${userA}, ${"c".repeat(64)}, 1, ${"a".repeat(64)}, now() + interval '1 minute')`;
  }, userA);
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`UPDATE artifact_upload_intents SET consumed_at=now() WHERE id=${intent}`, userA),
    /artifact upload intents are lifecycle-managed/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`DELETE FROM artifact_upload_intents WHERE id=${intent}`, userA),
    /artifact upload intents are lifecycle-managed/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`DELETE FROM artifacts WHERE id=${artifact}`, userA),
    /artifact lifecycle is managed by fixed functions/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`DELETE FROM submissions WHERE id=${submission}`, userA),
    /submission lifecycle is managed by fixed functions/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`INSERT INTO artifact_events (organization_id, artifact_id, event_type) VALUES (${organizationA}, ${artifact}, 'uploaded')`, userA),
    /artifact events are lifecycle-managed/,
  );
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`UPDATE artifacts SET status='ready', clean_key='clean/scoped-artifact', derived_key='derived/scoped-artifact', scan_completed_at=now(), parsed_at=now() WHERE id=${artifact}`, userA),
    /artifact lifecycle is managed by fixed functions/,
  );

  const operation = `artifact.upload:${intent}`;
  const key = `upload_${randomUUID().replaceAll("-", "")}`;
  await appTransaction(organizationA, async (transaction) => {
    await reserveIdempotencyKey(transaction, { organizationId: organizationA, operation, key, requestFingerprint: "f".repeat(64) });
    const completed = await transaction<{ artifact_id: string | null }[]>`SELECT complete_artifact_upload(${organizationA},${userA},${randomUUID()},${intent},${"c".repeat(64)},${operation},${key}) AS artifact_id`;
    assert.deepEqual(completed.map((row) => row.artifact_id), [artifact]);
    const state = await transaction<{ status: string; submission_state: string; consumed_at: Date | null }[]>`
      SELECT a.status, s.state AS submission_state, i.consumed_at
      FROM artifacts a JOIN submissions s ON s.id=a.submission_id AND s.organization_id=a.organization_id
      JOIN artifact_upload_intents i ON i.artifact_id=a.id AND i.organization_id=a.organization_id
      WHERE a.id=${artifact}`;
    assert.equal(state[0]?.status, "uploaded");
    assert.equal(state[0]?.submission_state, "uploading");
    assert.ok(state[0]?.consumed_at instanceof Date);
    assert.equal(await scalar(transaction, transaction`SELECT count(*) FROM artifact_events WHERE artifact_id=${artifact} AND event_type='uploaded'`), 1);
    assert.equal(await scalar(transaction, transaction`SELECT count(*) FROM outbox_events WHERE aggregate_id=${artifact} AND topic='artifact.normalize'`), 1);
  }, userA);
});

test("B04 submission inserts require learner enrollment at the database boundary", async () => {
  const nonMemberCourse = randomUUID();
  const assessment = randomUUID();
  const version = randomUUID();
  const submission = randomUUID();
  await appTransaction(organizationA, async (transaction) => {
    await transaction`INSERT INTO courses (id, organization_id, code, title) VALUES (${nonMemberCourse}, ${organizationA}, 'B04-NONMEMBER', 'Nonmember synthetic course')`;
    await transaction`INSERT INTO assessments (id, organization_id, course_id, title) VALUES (${assessment}, ${organizationA}, ${nonMemberCourse}, 'B04 nonmember assessment')`;
    await transaction`INSERT INTO assessment_versions (id, organization_id, course_id, assessment_id, version_number, title, assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary, completion_criteria, text_check_in, voice_check_in, extra_time, pause_and_resume, alternative_assessment_request, question_budget, time_budget_minutes, created_by) VALUES (${version}, ${organizationA}, ${nonMemberCourse}, ${assessment}, 1, 'B04 nonmember version', 'Synthetic instructions.', 'Synthetic policy.', 'allowed', 'Synthetic privacy.', 'Synthetic completion.', true, false, false, true, true, 3, 3, ${userA})`;
    await transaction`UPDATE assessment_versions SET state='published', published_by=${userA}, published_at=now() WHERE id=${version}`;
    await transaction`UPDATE assessments SET state='published', current_published_version_id=${version} WHERE id=${assessment}`;
  }, userA);
  await assert.rejects(
    () => appTransaction(organizationA, (transaction) => transaction`INSERT INTO submissions (id, organization_id, course_id, assessment_id, assessment_version_id, learner_id) VALUES (${submission}, ${organizationA}, ${nonMemberCourse}, ${assessment}, ${version}, ${userA})`, userA),
    /row-level security/,
  );
});

test("B04 API and worker database roles are separated", async () => {
  await assert.rejects(
    () => application`SELECT claim_artifact_outbox('api-role-must-not-claim', 5)`,
    /permission denied/,
  );
  await assert.rejects(
    () => worker`SELECT id FROM artifacts LIMIT 1`,
    /permission denied/,
  );
});

test("artifact outbox leasing is exclusive, retries with a bounded DLQ", async () => {
  const eventId = randomUUID();
  const aggregateId = randomUUID();
  await appTransaction(organizationA, async (transaction) => {
    await transaction`UPDATE outbox_events SET processed_at=now() WHERE topic='artifact.normalize' AND processed_at IS NULL AND dead_lettered_at IS NULL`;
  }, userA);
  await appTransaction(organizationA, async (transaction) => {
    await transaction`INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, topic, payload, dedupe_key) VALUES (${eventId}, ${organizationA}, 'artifact', ${aggregateId}, 'artifact.normalize', ${transaction.json({ artifact_id: aggregateId })}, ${`artifact.normalize:${aggregateId}`})`;
  }, userA);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claim = await worker<{ id: string; attempt_count: number }[]>`SELECT id,attempt_count FROM claim_artifact_outbox('lease-worker-a', 5)`;
    assert.deepEqual(claim.map((row) => row.id), [eventId]);
    assert.equal(claim[0]?.attempt_count, attempt);
    const contender = await worker`SELECT * FROM claim_artifact_outbox('lease-worker-b', 5)`;
    assert.equal(contender.length, 0);
    await worker`SELECT finish_artifact_outbox(${eventId}, 'lease-worker-a', false, 'scanner_unavailable')`;
    if (attempt < 5) await appTransaction(organizationA, (transaction) => transaction`UPDATE outbox_events SET available_at=now() WHERE id=${eventId}`, userA);
  }
  await appTransaction(organizationA, async (transaction) => {
    const state = await transaction<{ dead_lettered_at: Date | null; last_error_code: string | null; processed_at: Date | null }[]>`SELECT dead_lettered_at,last_error_code,processed_at FROM outbox_events WHERE id=${eventId}`;
    assert.ok(state[0]?.dead_lettered_at instanceof Date);
    assert.equal(state[0]?.last_error_code, "scanner_unavailable");
    assert.equal(state[0]?.processed_at, null);
    assert.equal((await worker`SELECT * FROM claim_artifact_outbox('lease-worker-c', 5)`).length, 0);
  }, userA);
});
