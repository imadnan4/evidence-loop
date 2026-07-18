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
  const entry = file.split(/\r?\n/).find((line) => line.startsWith("DATABASE_URL="));
  if (!entry) throw new Error("DATABASE_URL is required");
  return entry.slice("DATABASE_URL=".length);
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
  await databaseAdmin.unsafe(`GRANT SELECT ON internal_users, course_memberships, courses TO ${role}`);
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
