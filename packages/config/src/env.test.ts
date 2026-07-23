import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentError, parseServerEnvironment, redactEnvironmentError } from "./env.ts";

const local = {
  EVIDENCE_LOOP_ENV: "local",
  PORT: "3001",
  SYNTHETIC_DATA_ONLY: "true",
  DATABASE_URL: "postgresql://evidence_loop:local-only-password@127.0.0.1:5432/evidence_loop",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "local-minio-access-key",
  S3_SECRET_ACCESS_KEY: "local-minio-secret-key",
  S3_BUCKET_QUARANTINE: "quarantine",
  S3_BUCKET_CLEAN: "clean",
  S3_BUCKET_DERIVED: "derived",
  OIDC_ISSUER: "http://127.0.0.1:9100",
  OIDC_JWKS_URI: "http://127.0.0.1:9100/jwks",
  OIDC_AUDIENCE: "evidence-loop-api",
  OIDC_ORGANIZATION_CLAIM: "https://evidence-loop.test/organization_id",
  ALLOWED_WEB_ORIGINS: "http://127.0.0.1:3000",
  DEPLOYMENT_ID: "local",
  RELEASE_VERSION: "dev",
};

test("accepts a complete synthetic local environment", () => {
  const environment = parseServerEnvironment(local);
  assert.equal(environment.profile, "local");
  assert.equal(environment.syntheticDataOnly, true);
  assert.equal(environment.objectStorage.buckets.clean, "clean");
});

test("accepts CI loopback dependencies", () => {
  const environment = parseServerEnvironment({ ...local, EVIDENCE_LOOP_ENV: "ci", DEPLOYMENT_ID: "ci-123" });
  assert.equal(environment.profile, "ci");
});

test("fails closed without a required value and does not reveal values", () => {
  assert.throws(
    () => parseServerEnvironment({ ...local, S3_SECRET_ACCESS_KEY: "" }),
    (error: unknown) => error instanceof EnvironmentError && error.variable === "S3_SECRET_ACCESS_KEY" && error.code === "required",
  );
});

test("rejects browser-public namespaces", () => {
  assert.throws(
    () => parseServerEnvironment({ ...local, NEXT_PUBLIC_S3_SECRET_ACCESS_KEY: "must-not-be-here" }),
    (error: unknown) => error instanceof EnvironmentError && error.code === "browser-namespace-not-allowed",
  );
});

test("rejects client credentials in a resource-server configuration", () => {
  assert.throws(
    () => parseServerEnvironment({ ...local, OIDC_CLIENT_SECRET: "not-a-real-secret" }),
    (error: unknown) => error instanceof EnvironmentError && error.variable === "OIDC_CLIENT_SECRET" && error.code === "resource-server-does-not-use-client-credentials",
  );
});

test("staging rejects full loopback range including 127.0.0.2 and IPv6-mapped", () => {
  assert.throws(
    () => parseServerEnvironment({ ...local, EVIDENCE_LOOP_ENV: "staging", S3_ENDPOINT: "http://127.0.0.2:9000", OIDC_ISSUER: "https://issuer.example.test", OIDC_JWKS_URI: "https://issuer.example.test/jwks", ALLOWED_WEB_ORIGINS: "https://staging.example.test" }),
    (error: unknown) => error instanceof EnvironmentError && error.code === "staging-requires-https-non-loopback",
  );
  assert.throws(
    () => parseServerEnvironment({ ...local, EVIDENCE_LOOP_ENV: "staging", S3_ENDPOINT: "http://[::ffff:127.0.0.1]:9000", OIDC_ISSUER: "https://issuer.example.test", OIDC_JWKS_URI: "https://issuer.example.test/jwks", ALLOWED_WEB_ORIGINS: "https://staging.example.test" }),
    (error: unknown) => error instanceof EnvironmentError && error.code === "staging-requires-https-non-loopback",
  );
});

test("staging rejects loopback object storage and placeholder credentials", () => {
  assert.throws(
    () => parseServerEnvironment({ ...local, EVIDENCE_LOOP_ENV: "staging", OIDC_ISSUER: "https://issuer.example.test", OIDC_JWKS_URI: "https://issuer.example.test/jwks", ALLOWED_WEB_ORIGINS: "https://staging.example.test" }),
    (error: unknown) => error instanceof EnvironmentError && error.variable === "OIDC_ISSUER" && error.code === "staging-requires-https-non-loopback",
  );
  assert.throws(
    () => parseServerEnvironment({
      ...local,
      EVIDENCE_LOOP_ENV: "staging",
      OIDC_ISSUER: "https://issuer.example.test",
      OIDC_JWKS_URI: "https://issuer.example.test/jwks",
      DATABASE_URL: "postgresql://service:production-password@db.example.test:5432/evidence_loop",
      S3_ENDPOINT: "https://objects.example.test",
      S3_ACCESS_KEY_ID: "change-me",
      S3_SECRET_ACCESS_KEY: "not-a-production-secret",
      ALLOWED_WEB_ORIGINS: "https://staging.example.test",
    }),
    (error: unknown) => error instanceof EnvironmentError && error.variable === "S3_ACCESS_KEY_ID" && error.code === "staging-placeholder-credential",
  );
});

test("redacted errors contain only a key and a reason code", () => {
  const redacted = redactEnvironmentError(new EnvironmentError("S3_SECRET_ACCESS_KEY", "required"));
  assert.equal(redacted, "S3_SECRET_ACCESS_KEY: required");
  assert.doesNotMatch(redacted, /local-minio-secret-key/);
});
