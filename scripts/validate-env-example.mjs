import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function parse(text) {
  return new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}
const [bootstrapText, runtimeText] = await Promise.all([
  readFile(new URL("../infra/env/.env.example", import.meta.url), "utf8"),
  readFile(new URL("../infra/env/.env.runtime.example", import.meta.url), "utf8"),
]);
const bootstrap = parse(bootstrapText);
const runtime = parse(runtimeText);
for (const variable of ["EVIDENCE_LOOP_ENV", "SYNTHETIC_DATA_ONLY", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
  assert.ok(bootstrap.has(variable), `Missing ${variable} from bootstrap example`);
}
for (const variable of ["EVIDENCE_LOOP_ENV", "SYNTHETIC_DATA_ONLY", "PORT", "DATABASE_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_QUARANTINE", "S3_BUCKET_CLEAN", "S3_BUCKET_DERIVED", "OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE", "OIDC_ORGANIZATION_CLAIM", "ALLOWED_WEB_ORIGINS", "DEPLOYMENT_ID", "RELEASE_VERSION"]) {
  assert.ok(runtime.has(variable), `Missing ${variable} from runtime example`);
}
for (const forbidden of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "MIGRATION_DATABASE_URL", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
  assert.ok(!runtime.has(forbidden), `Runtime example must not contain ${forbidden}`);
}
assert.equal(bootstrap.get("SYNTHETIC_DATA_ONLY"), "true");
assert.equal(runtime.get("SYNTHETIC_DATA_ONLY"), "true");
for (const secret of ["POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "MINIO_ROOT_PASSWORD"]) {
  assert.match(bootstrap.get(secret) ?? "", /^GENERATE_LOCALLY_[A-Z_]+$/, `${secret} must be a generated placeholder`);
}
for (const secret of ["S3_SECRET_ACCESS_KEY", "DATABASE_URL"]) {
  assert.match(runtime.get(secret) ?? "", /GENERATE_LOCALLY_/, `${secret} must be a generated placeholder`);
}
assert.doesNotMatch(`${bootstrapText}\n${runtimeText}`, /sk-[A-Za-z0-9]/, "Examples must not contain an API key");
console.log("Bootstrap and runtime environment examples are complete, synthetic-only, and credential-isolated.");
