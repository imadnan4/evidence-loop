import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres, { type Sql } from "postgres";
import { applyMigrations } from "@evidence-loop/db";
import { buildApp } from "../src/http/app.ts";

function databaseName(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function databaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = await readFile(new URL("../../../infra/env/.env.local", import.meta.url), "utf8");
  const variables = new Map(file.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
  const direct = variables.get("DATABASE_URL");
  if (direct) return direct;
  const user = variables.get("POSTGRES_USER");
  const password = variables.get("POSTGRES_PASSWORD");
  const database = variables.get("POSTGRES_DB");
  const port = variables.get("POSTGRES_PORT") ?? "5432";
  if (!user || !password || !database) throw new Error("DATABASE_URL is required");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function rewriteDatabase(url: string, name: string, user?: string, password?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return parsed.href;
}

async function startJwks(publicJwk: JsonWebKey) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const organizationA = randomUUID();
const organizationB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const courseA = randomUUID();
const courseB = randomUUID();
const isolatedDatabase = databaseName("el_b01");
const role = databaseName("elapp").slice(0, 62);
const password = randomBytes(24).toString("hex");
let admin: Sql<{}>;
let databaseAdmin: Sql<{}>;
let application: Sql<{}>;
let app: ReturnType<typeof buildApp>;
let signToken: (subject: string, organizationId: string) => Promise<string>;
let closeJwks: () => Promise<void>;
const quarantineObjects = new Map<string, Buffer>();
const artifactStorage = {
  putQuarantine: async (key: string, bytes: Buffer) => { quarantineObjects.set(key, Buffer.from(bytes)); },
  readQuarantine: async (key: string) => {
    const bytes = quarantineObjects.get(key);
    if (!bytes) throw new Error("missing synthetic quarantine object");
    return Buffer.from(bytes);
  },
  deleteQuarantine: async (key: string) => { quarantineObjects.delete(key); },
  putClean: async () => undefined,
  putDerived: async () => undefined,
};

test.before(async () => {
  const baseUrl = await databaseUrl();
  admin = postgres(baseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${isolatedDatabase}`);
  databaseAdmin = postgres(rewriteDatabase(baseUrl, isolatedDatabase), { max: 1, prepare: false });
  await applyMigrations(databaseAdmin);

  await databaseAdmin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT`);
  await databaseAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await databaseAdmin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await databaseAdmin.unsafe(`GRANT EXECUTE ON FUNCTION complete_artifact_upload(uuid, uuid, uuid, uuid, text, text, text) TO ${role}`);
  application = postgres(rewriteDatabase(baseUrl, isolatedDatabase, role, password), { max: 1, prepare: false });

  await databaseAdmin`
    INSERT INTO organizations (id, slug, display_name)
    VALUES (${organizationA}, 'b01-tenant-a', 'Synthetic Tenant A'), (${organizationB}, 'b01-tenant-b', 'Synthetic Tenant B')`;
  await databaseAdmin`
    INSERT INTO internal_users (id, organization_id, subject)
    VALUES (${userA}, ${organizationA}, 'issuer|learner-a'), (${userB}, ${organizationB}, 'issuer|learner-b')`;
  await databaseAdmin`
    INSERT INTO courses (id, organization_id, code, title)
    VALUES (${courseA}, ${organizationA}, 'A01', 'Synthetic A'), (${courseB}, ${organizationB}, 'B01', 'Synthetic B')`;
  await databaseAdmin`
    INSERT INTO course_memberships (course_id, user_id, organization_id, role)
    VALUES (${courseA}, ${userA}, ${organizationA}, 'instructor'), (${courseB}, ${userB}, ${organizationB}, 'learner')`;


  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "integration-key";
  publicJwk.alg = "RS256";
  const jwks = await startJwks(publicJwk);
  closeJwks = jwks.close;
  signToken = (subject, organizationId) => new SignJWT({ org: organizationId })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key", typ: "JWT" })
    .setIssuer(jwks.origin)
    .setAudience("evidence-loop-api")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  app = buildApp({
    environment: {
      profile: "ci",
      port: 3001,
      databaseUrl: new URL(rewriteDatabase(baseUrl, isolatedDatabase, role, password)),
      objectStorage: { endpoint: new URL("http://minio:9000"), region: "us-east-1", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret", buckets: { quarantine: "quarantine", clean: "clean", derived: "derived" } },
      oidc: { issuer: new URL(jwks.origin), jwksUri: new URL(`${jwks.origin}/jwks`), audience: "evidence-loop-api", organizationClaim: "org" },
      allowedWebOrigins: [new URL("http://127.0.0.1:3000")],
      deploymentId: "b01-integration",
      releaseVersion: "test",
      syntheticDataOnly: true,
    },
    client: application,
    artifactStorage,
  });
});

test.after(async () => {
  await app?.close();
  await closeJwks?.();
  await application?.end({ timeout: 2 });
  await databaseAdmin?.end({ timeout: 2 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${isolatedDatabase} WITH (FORCE)`);
  await admin?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await admin?.end({ timeout: 2 });
});

test("authenticated durable principals receive only their tenant course role", async () => {
  const token = await signToken("issuer|learner-a", organizationA);
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { userId: userA, organizationId: organizationA });

  const ownCourse = await app.inject({ method: "GET", url: `/v1/courses/${courseA}/access`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(ownCourse.statusCode, 200);
  assert.deepEqual(ownCourse.json(), { courseId: courseA, role: "instructor" });

  const instructorAccess = await app.inject({ method: "GET", url: `/v1/courses/${courseA}/instructor-access`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(instructorAccess.statusCode, 200);
});

test("cross-tenant, insufficient-role, and unknown-subject requests fail closed without provisioning", async () => {
  const tenantB = await signToken("issuer|learner-b", organizationB);
  const crossTenant = await app.inject({ method: "GET", url: `/v1/courses/${courseA}/access`, headers: { authorization: `Bearer ${tenantB}` } });
  assert.equal(crossTenant.statusCode, 404);

  const learnerOnly = await app.inject({ method: "GET", url: `/v1/courses/${courseB}/instructor-access`, headers: { authorization: `Bearer ${tenantB}` } });
  assert.equal(learnerOnly.statusCode, 404);

  const unknown = await signToken("issuer|not-provisioned", organizationA);
  const unknownResponse = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${unknown}` } });
  assert.equal(unknownResponse.statusCode, 401);

  const rows = await databaseAdmin<{ count: string }[]>`SELECT count(*) FROM internal_users WHERE subject = 'issuer|not-provisioned'`;
  assert.equal(rows[0]?.count, "0");
});

const learnerA = randomUUID();

test("B02 durable assessment API enforces tenant membership, idempotency, publication, and immutable snapshots", async () => {
  // Provision a learner in the same course; tenant B remains a cross-tenant control.
  await databaseAdmin`INSERT INTO internal_users (id, organization_id, subject) VALUES (${learnerA}, ${organizationA}, 'issuer|learner-a-viewer')`;
  await databaseAdmin`INSERT INTO course_memberships (course_id, user_id, organization_id, role) VALUES (${courseA}, ${learnerA}, ${organizationA}, 'learner')`;

  const objectiveIds = [randomUUID(), randomUUID(), randomUUID()];
  const draft = {
    title: "Durable synthetic assessment",
    assignment_instructions: "Explain how validation avoids leakage.",
    objectives: objectiveIds.map((id, index) => ({
      id,
      label: `Objective ${index + 1}`,
      description: "Synthetic approved objective.",
      evidence_criteria: "A cited explanation.",
      assessable_in_check_in: true,
    })),
    rubric: [{
      label: "Validation criterion",
      description: "Learner explains validation.",
      evidence_criteria: "Artifact and response references.",
      objective_ids: [objectiveIds[0]],
    }],
    policy: {
      learner_facing_text: "Text check-in is always available.",
      ai_use_policy: "allowed",
      privacy_summary: "Synthetic test data only.",
      completion_criteria: "Answer three finite questions.",
    },
    accommodations: { text_check_in: true, voice_check_in: false, extra_time: true, pause_and_resume: true, alternative_assessment_request: true },
    question_budget: 3,
    time_budget_minutes: 3,
  };
  const instructorToken = await signToken("issuer|learner-a", organizationA);
  const createHeaders = { authorization: `Bearer ${instructorToken}`, "idempotency-key": "assessment-create-1" };
  const created = await app.inject({ method: "POST", url: `/v1/courses/${courseA}/assessments`, headers: createHeaders, payload: draft });
  assert.equal(created.statusCode, 201);
  const createdBody = created.json();
  assert.equal(createdBody.replayed, false);
  const assessmentId = createdBody.assessment_id as string;
  const versionId = createdBody.draft.id as string;
  assert.deepEqual(createdBody.draft.rubric[0].objective_ids, [objectiveIds[0]]);

  const replay = await app.inject({ method: "POST", url: `/v1/courses/${courseA}/assessments`, headers: createHeaders, payload: draft });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().assessment_id, assessmentId);

  const conflict = await app.inject({ method: "POST", url: `/v1/courses/${courseA}/assessments`, headers: createHeaders, payload: { ...draft, title: "Changed payload" } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "idempotency_conflict");

  const crossTenantToken = await signToken("issuer|learner-b", organizationB);
  const crossTenant = await app.inject({ method: "POST", url: `/v1/courses/${courseA}/assessments`, headers: { authorization: `Bearer ${crossTenantToken}`, "idempotency-key": "cross-tenant" }, payload: draft });
  assert.equal(crossTenant.statusCode, 404);

  const publish = await app.inject({ method: "POST", url: `/v1/assessment-versions/${versionId}/publish`, headers: { authorization: `Bearer ${instructorToken}`, "idempotency-key": "assessment-publish-1" } });
  assert.equal(publish.statusCode, 200);
  assert.equal(publish.json().published.state, "published");

  const learnerToken = await signToken("issuer|learner-a-viewer", organizationA);
  const published = await app.inject({ method: "GET", url: `/v1/assessments/${assessmentId}/published`, headers: { authorization: `Bearer ${learnerToken}` } });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().published.id, versionId);

  await assert.rejects(
    () => databaseAdmin`UPDATE assessment_objectives SET label = 'tampered' WHERE assessment_version_id = ${versionId}`,
    /immutable/,
  );
  await assert.rejects(
    () => databaseAdmin`INSERT INTO assessment_objectives (organization_id, assessment_id, assessment_version_id, position, label, description, evidence_criteria, assessable_in_check_in, approved_by) VALUES (${organizationA}, ${assessmentId}, ${versionId}, 4, 'Late objective', 'Should fail', 'Should fail', true, ${userA})`,
    /immutable/,
  );
});


test("B04 keeps durable uploads private, one-use, and learner scoped", async () => {
  const learner = randomUUID();
  const secondLearner = randomUUID();
  const assessmentId = randomUUID();
  const versionId = randomUUID();
  await databaseAdmin`INSERT INTO internal_users (id, organization_id, subject) VALUES (${learner}, ${organizationA}, 'issuer|b04-learner'), (${secondLearner}, ${organizationA}, 'issuer|b04-other')`;
  await databaseAdmin`INSERT INTO course_memberships (course_id, user_id, organization_id, role) VALUES (${courseA}, ${learner}, ${organizationA}, 'learner'), (${courseA}, ${secondLearner}, ${organizationA}, 'learner')`;
  await databaseAdmin`INSERT INTO assessments (id, organization_id, course_id, title, state) VALUES (${assessmentId}, ${organizationA}, ${courseA}, 'B04 private upload', 'published')`;
  await databaseAdmin`
    INSERT INTO assessment_versions (id, organization_id, course_id, assessment_id, version_number, state, title, assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary, completion_criteria, text_check_in, voice_check_in, extra_time, pause_and_resume, alternative_assessment_request, question_budget, time_budget_minutes, created_by, published_by, published_at)
    VALUES (${versionId}, ${organizationA}, ${courseA}, ${assessmentId}, 1, 'published', 'B04 version', 'Synthetic instructions.', 'Synthetic policy.', 'allowed', 'Synthetic privacy.', 'Synthetic completion.', true, false, false, true, true, 3, 3, ${userA}, ${userA}, now())`;
  await databaseAdmin`UPDATE assessments SET current_published_version_id=${versionId} WHERE id=${assessmentId}`;
  const learnerToken = await signToken("issuer|b04-learner", organizationA);
  const otherToken = await signToken("issuer|b04-other", organizationA);
  const staffToken = await signToken("issuer|learner-a", organizationA);
  const submissionHeaders = { authorization: `Bearer ${learnerToken}`, "idempotency-key": "b04-submission-key-0001" };
  const submission = await app.inject({ method: "POST", url: `/v1/assessment-versions/${versionId}/submissions`, headers: submissionHeaders });
  assert.equal(submission.statusCode, 201);
  const submissionId = submission.json().submission_id as string;
  const submissionReplay = await app.inject({ method: "POST", url: `/v1/assessment-versions/${versionId}/submissions`, headers: submissionHeaders });
  assert.equal(submissionReplay.statusCode, 200);
  assert.equal(submissionReplay.json().submission_id, submissionId);

  const bytes = Buffer.from("hello", "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const intentPayload = { file_name: "private.txt", content_type: "text/plain", byte_size: bytes.length, sha256: digest };
  const intentHeaders = { authorization: `Bearer ${learnerToken}`, "idempotency-key": "b04-intent-key-00000001" };
  const intent = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/artifacts/upload-intents`, headers: intentHeaders, payload: intentPayload });
  assert.equal(intent.statusCode, 201);
  const intentBody = intent.json();
  assert.ok(typeof intentBody.upload_capability === "string" && intentBody.upload_capability.length >= 32);
  for (const forbidden of ["bucket", "key", "url", "filename", "sha256", "content"]) assert.ok(!Object.hasOwn(intentBody, forbidden));
  const intentReplay = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/artifacts/upload-intents`, headers: intentHeaders, payload: intentPayload });
  assert.equal(intentReplay.statusCode, 200);
  assert.equal(intentReplay.json().upload_intent_id, intentBody.upload_intent_id);
  assert.equal(intentReplay.json().upload_capability, intentBody.upload_capability);
  const intentConflict = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/artifacts/upload-intents`, headers: intentHeaders, payload: { ...intentPayload, sha256: "f".repeat(64) } });
  assert.equal(intentConflict.statusCode, 409);

  const uploadHeaders = { authorization: `Bearer ${learnerToken}`, "upload-capability": intentBody.upload_capability, "idempotency-key": "b04-upload-key-00000001", "content-type": "application/octet-stream" };
  const uploaded = await app.inject({ method: "PUT", url: `/v1/artifact-upload-intents/${intentBody.upload_intent_id}/content`, headers: uploadHeaders, payload: bytes });
  assert.equal(uploaded.statusCode, 201);
  const uploadedBody = uploaded.json();
  assert.equal(uploadedBody.status, "uploaded");
  const uploadReplay = await app.inject({ method: "PUT", url: `/v1/artifact-upload-intents/${intentBody.upload_intent_id}/content`, headers: uploadHeaders, payload: bytes });
  assert.equal(uploadReplay.statusCode, 200);
  assert.equal(uploadReplay.json().artifact_id, uploadedBody.artifact_id);
  const otherUpload = await app.inject({ method: "PUT", url: `/v1/artifact-upload-intents/${intentBody.upload_intent_id}/content`, headers: { ...uploadHeaders, authorization: `Bearer ${otherToken}`, "idempotency-key": "b04-other-upload-key-01" }, payload: bytes });
  assert.equal(otherUpload.statusCode, 404);
  const otherStatus = await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}/artifacts/${uploadedBody.artifact_id}`, headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(otherStatus.statusCode, 404);
  const staffStatus = await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}/artifacts/${uploadedBody.artifact_id}`, headers: { authorization: `Bearer ${staffToken}` } });
  assert.equal(staffStatus.statusCode, 200);
  const status = staffStatus.json();
  assert.deepEqual(status, { artifact_id: uploadedBody.artifact_id, status: "uploaded", reason_code: null });
  for (const forbidden of ["quarantine_key", "clean_key", "derived_key", "filename", "sha256", "content", "url", "fragment_count", "created_at", "updated_at", "byte_size"]) assert.ok(!Object.hasOwn(status, forbidden));

  const expiring = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/artifacts/upload-intents`, headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": "b04-expiring-intent-0001" }, payload: intentPayload });
  assert.equal(expiring.statusCode, 201);
  await databaseAdmin`UPDATE artifact_upload_intents SET expires_at=now()-interval '1 second' WHERE id=${expiring.json().upload_intent_id}`;
  const expired = await app.inject({ method: "PUT", url: `/v1/artifact-upload-intents/${expiring.json().upload_intent_id}/content`, headers: { authorization: `Bearer ${learnerToken}`, "upload-capability": expiring.json().upload_capability, "idempotency-key": "b04-expired-upload-0001", "content-type": "application/octet-stream" }, payload: bytes });
  assert.equal(expired.statusCode, 409);
  const mismatched = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/artifacts/upload-intents`, headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": "b04-mismatch-intent-0001" }, payload: { ...intentPayload, byte_size: 6 } });
  assert.equal(mismatched.statusCode, 201);
  const badBytes = await app.inject({ method: "PUT", url: `/v1/artifact-upload-intents/${mismatched.json().upload_intent_id}/content`, headers: { authorization: `Bearer ${learnerToken}`, "upload-capability": mismatched.json().upload_capability, "idempotency-key": "b04-mismatch-upload-000", "content-type": "application/octet-stream" }, payload: bytes });
  assert.equal(badBytes.statusCode, 400);
});

test("B02 rolls back domain, audit, outbox, and idempotency effects on a failed durable write", async () => {
  const { DurableAssessmentService } = await import("../src/assessment/durable-service.ts");
  const objectiveId = randomUUID();
  const unmappedObjectiveId = randomUUID();
  const rollbackKey = `assessment-rollback-${randomUUID()}`;
  const rollbackBody = {
    title: "Rollback only",
    assignment_instructions: "Synthetic instruction.",
    objectives: [1, 2, 3].map((position) => ({
      id: position === 2 ? objectiveId : randomUUID(),
      label: `Objective ${position}`,
      description: "Synthetic objective.",
      evidence_criteria: "Synthetic evidence.",
      assessable_in_check_in: true,
    })),
    // Service-level callers cannot create a rubric mapping to an objective that
    // was not inserted into this version; the FK must roll back all prior writes.
    rubric: [{ label: "Criterion", description: "Synthetic criterion.", evidence_criteria: "Synthetic evidence.", objective_ids: [unmappedObjectiveId] }],
    policy: { learner_facing_text: "Text route.", ai_use_policy: "allowed" as const, privacy_summary: "Synthetic.", completion_criteria: "Finite." },
    accommodations: { text_check_in: true, voice_check_in: false, extra_time: false, pause_and_resume: true, alternative_assessment_request: true },
    question_budget: 3,
    time_budget_minutes: 3,
  };
  const service = new DurableAssessmentService(application);
  await assert.rejects(
    () => service.createInitialDraft({ organizationId: organizationA, userId: userA, subject: "issuer|learner-a", correlationId: randomUUID() }, courseA, rollbackBody, rollbackKey),
  );
  const idempotencyRows = await databaseAdmin<{ count: string }[]>`SELECT count(*) FROM idempotency_keys WHERE organization_id = ${organizationA} AND operation = 'assessment.create_initial' AND key = ${rollbackKey}`;
  const resultRows = await databaseAdmin<{ count: string }[]>`SELECT count(*) FROM idempotency_results WHERE organization_id = ${organizationA} AND operation = 'assessment.create_initial' AND key = ${rollbackKey}`;
  assert.equal(idempotencyRows[0]?.count, "0");
  assert.equal(resultRows[0]?.count, "0");
});

const learnerSession = randomUUID();

test("C02 durable text check-in enforces tenant ownership, finite budget, and request idempotency", async () => {
  // Provision a learner, a published assessment version with three approved
  // assessable objectives, a ready submission, and artifact fragments. These are
  // inserted directly because published-version objectives/fragments are immutable
  // (the app route set rejects tampering) and the resolver reads them in a tenant
  // transaction.
  await databaseAdmin`INSERT INTO internal_users (id, organization_id, subject) VALUES (${learnerSession}, ${organizationA}, 'issuer|session-learner')`;
  await databaseAdmin`INSERT INTO course_memberships (course_id, user_id, organization_id, role) VALUES (${courseA}, ${learnerSession}, ${organizationA}, 'learner')`;

  const assessmentId = randomUUID();
  const versionId = randomUUID();
  // Objectives may only be inserted while the version is a draft; the immutable
  // trigger blocks child writes once the version is published. Insert the draft,
  // its approved objectives, then promote to published.
  await databaseAdmin`INSERT INTO assessments (id, organization_id, course_id, title, state) VALUES (${assessmentId}, ${organizationA}, ${courseA}, 'C02 check-in assessment', 'draft')`;
  await databaseAdmin`
    INSERT INTO assessment_versions (id, organization_id, course_id, assessment_id, version_number, state, title, assignment_instructions, learner_facing_text, ai_use_policy, privacy_summary, completion_criteria, text_check_in, voice_check_in, extra_time, pause_and_resume, alternative_assessment_request, question_budget, time_budget_minutes, created_by, published_by, published_at)
    VALUES (${versionId}, ${organizationA}, ${courseA}, ${assessmentId}, 1, 'draft', 'C02 version', 'Synthetic instructions.', 'Text check-in is always available.', 'allowed', 'Synthetic privacy.', 'Answer finite questions.', true, false, false, true, true, 3, 8, ${userA}, NULL, NULL)`;

  const objectiveIds = [randomUUID(), randomUUID(), randomUUID()];
  for (let position = 1; position <= 3; position++) {
    await databaseAdmin`
      INSERT INTO assessment_objectives (id, organization_id, assessment_id, assessment_version_id, position, label, description, evidence_criteria, assessable_in_check_in, approved_by, approved_at)
      VALUES (${objectiveIds[position - 1]!}, ${organizationA}, ${assessmentId}, ${versionId}, ${position}, ${`Objective ${position}`}, 'Synthetic approved objective.', 'A cited explanation.', true, ${userA}, now())`;
  }

  await databaseAdmin`UPDATE assessment_versions SET state='published', published_by=${userA}, published_at=now() WHERE id=${versionId}`;
  await databaseAdmin`UPDATE assessments SET state='published', current_published_version_id=${versionId} WHERE id=${assessmentId}`;

  const submissionId = randomUUID();
  await databaseAdmin`
    INSERT INTO submissions (id, organization_id, course_id, assessment_id, assessment_version_id, learner_id, state)
    VALUES (${submissionId}, ${organizationA}, ${courseA}, ${assessmentId}, ${versionId}, ${learnerSession}, 'ready')`;

  const artifactId = randomUUID();
  const fragmentHash = createHash("sha256").update("hello").digest("hex");
  await databaseAdmin`
    INSERT INTO artifacts (id, organization_id, submission_id, quarantine_key, clean_key, derived_key, declared_extension, declared_content_type, byte_size, sha256, status, scanner_version, parser_version, scan_completed_at, parsed_at)
    VALUES (${artifactId}, ${organizationA}, ${submissionId}, 'synthetic-quarantine', 'synthetic-clean', 'synthetic-derived', '.txt', 'text/plain', 5, ${fragmentHash}, 'ready', 'synthetic', 'synthetic-1', now(), now())`;

  const fragmentIds = [randomUUID(), randomUUID(), randomUUID()];
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    await databaseAdmin`
      INSERT INTO artifact_fragments (id, organization_id, submission_id, artifact_id, ordinal, locator, content_type, content, content_hash, parser_version)
      VALUES (${fragmentIds[ordinal]!}, ${organizationA}, ${submissionId}, ${artifactId}, ${ordinal}, ${databaseAdmin.json({ kind: "text", fragment: ordinal })}, 'text', 'Synthetic fragment.', ${fragmentHash}, 'synthetic-1')`;
  }

  const learnerToken = await signToken("issuer|session-learner", organizationA);

  // Create the check-in (request-level idempotency via Idempotency-Key header).
  const createHeaders = { authorization: `Bearer ${learnerToken}`, "idempotency-key": "c02-create-0001" };
  const created = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/check-ins`, headers: createHeaders });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().replayed, false);
  const sessionId = created.json().check_in_id as string;
  assert.equal(created.json().session.state, "ready");

  const replay = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/check-ins`, headers: createHeaders });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().check_in_id, sessionId);

  const crossTenantToken = await signToken("issuer|learner-b", organizationB);
  const crossTenant = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/check-ins`, headers: { authorization: `Bearer ${crossTenantToken}`, "idempotency-key": "c02-cross-tenant" } });
  assert.equal(crossTenant.statusCode, 404);

  const policyHeaders = { authorization: `Bearer ${learnerToken}`, "idempotency-key": "c02-policy-0001" };
  const policy = await app.inject({ method: "POST", url: `/v1/check-ins/${sessionId}/policy`, headers: policyHeaders });
  assert.equal(policy.statusCode, 200);
  assert.equal(policy.json().session.state, "ready");

  const acknowledge = await app.inject({
    method: "POST",
    url: `/v1/check-ins/${sessionId}/policy/acknowledge`,
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": "c02-ack-0001" },
    payload: { policy_version_id: versionId },
  });
  assert.equal(acknowledge.statusCode, 200);
  assert.equal(acknowledge.json().session.state, "ready");

  const start = await app.inject({
    method: "POST",
    url: `/v1/check-ins/${sessionId}/start`,
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": "c02-start-0001" },
    payload: { policy_version_id: versionId, mode: "text" },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().session.state, "in_progress");
  assert.equal(start.json().question.sequence, 1);
  let sessionState = start.json().session.state as string;
  let questionId = start.json().question.id as string;

  // Submit exactly the finite question budget of responses.
  let responseCount = 0;
  while (sessionState === "in_progress" && questionId) {
    const submit = await app.inject({
      method: "POST",
      url: `/v1/check-ins/${sessionId}/questions/${questionId}/responses`,
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": `c02-response-${responseCount}` },
      payload: { canonical_text: "Synthetic learner reasoning.", edited_text: null },
    });
    assert.equal(submit.statusCode, 200);
    responseCount++;
    sessionState = submit.json().session.state;
    questionId = submit.json().next_question?.id ?? "";
  }
  assert.equal(responseCount, 3);
  assert.equal(sessionState, "completed");

  // Receipt is available only after completion.
  const receipt = await app.inject({ method: "GET", url: `/v1/check-ins/${sessionId}/receipt`, headers: { authorization: `Bearer ${learnerToken}` } });
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.json().session.state, "completed");
  assert.equal((receipt.json().questions as unknown[]).length, 3);
  assert.equal((receipt.json().responses as unknown[]).length, 3);

  // Timeline records owned events.
  const timeline = await app.inject({ method: "GET", url: `/v1/check-ins/${sessionId}/timeline`, headers: { authorization: `Bearer ${learnerToken}` } });
  assert.equal(timeline.statusCode, 200);
  assert.ok((timeline.json().events as unknown[]).length >= 5);

  // A second create on the same submission reuses the same tenant-scoped session.
  const second = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/check-ins`, headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": "c02-create-0002" } });
  assert.equal(second.statusCode, 409);

  // Cross-tenant read of the receipt fails closed.
  const crossReceipt = await app.inject({ method: "GET", url: `/v1/check-ins/${sessionId}/receipt`, headers: { authorization: `Bearer ${crossTenantToken}` } });
  assert.equal(crossReceipt.statusCode, 404);
});
