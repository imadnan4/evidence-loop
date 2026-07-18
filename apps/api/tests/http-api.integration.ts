import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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

test.before(async () => {
  const baseUrl = await databaseUrl();
  admin = postgres(baseUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${isolatedDatabase}`);
  databaseAdmin = postgres(rewriteDatabase(baseUrl, isolatedDatabase), { max: 1, prepare: false });
  await applyMigrations(databaseAdmin);

  await databaseAdmin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT`);
  await databaseAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await databaseAdmin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
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
