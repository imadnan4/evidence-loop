import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function parse(text) {
  return new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}
const [bootstrapText, runtimeText, workerRuntimeText] = await Promise.all([
  readFile(new URL("../infra/env/.env.example", import.meta.url), "utf8"),
  readFile(new URL("../infra/env/.env.runtime.example", import.meta.url), "utf8"),
  readFile(new URL("../infra/env/.env.worker.runtime.example", import.meta.url), "utf8"),
]);
const bootstrap = parse(bootstrapText);
const runtime = parse(runtimeText);
const workerRuntime = parse(workerRuntimeText);
for (const variable of ["EVIDENCE_LOOP_ENV", "SYNTHETIC_DATA_ONLY", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
  assert.ok(bootstrap.has(variable), `Missing ${variable} from bootstrap example`);
}
const runtimeVariables = ["EVIDENCE_LOOP_ENV", "SYNTHETIC_DATA_ONLY", "PORT", "DATABASE_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_QUARANTINE", "S3_BUCKET_CLEAN", "S3_BUCKET_DERIVED", "OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE", "OIDC_ORGANIZATION_CLAIM", "ALLOWED_WEB_ORIGINS", "DEPLOYMENT_ID", "RELEASE_VERSION"];
for (const variable of runtimeVariables) assert.ok(runtime.has(variable), `Missing ${variable} from API runtime example`);
for (const variable of ["EVIDENCE_LOOP_ENV", "SYNTHETIC_DATA_ONLY", "DATABASE_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_QUARANTINE", "S3_BUCKET_CLEAN", "S3_BUCKET_DERIVED", "CLAMD_SOCKET", "CLAMD_SIGNATURE_DIRECTORY", "CLAMD_MAX_SIGNATURE_AGE_SECONDS"]) assert.ok(workerRuntime.has(variable), `Missing ${variable} from worker runtime example`);
assert.match(workerRuntime.get("CLAMD_SOCKET") ?? "", /^\//, "Worker scanner socket must be an absolute Unix path");
assert.match(workerRuntime.get("CLAMD_SIGNATURE_DIRECTORY") ?? "", /^\//, "Worker signature directory must be an absolute path");
assert.match(workerRuntime.get("CLAMD_MAX_SIGNATURE_AGE_SECONDS") ?? "", /^(?:[1-9]\d{2,5}|[1-6]\d{5,6})$/, "Worker signature age must be bounded positive seconds");
for (const forbidden of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "MIGRATION_DATABASE_URL", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
  assert.ok(!runtime.has(forbidden), `API runtime example must not contain ${forbidden}`);
  assert.ok(!workerRuntime.has(forbidden), `Worker runtime example must not contain ${forbidden}`);
}
assert.equal(bootstrap.get("SYNTHETIC_DATA_ONLY"), "true");
assert.equal(runtime.get("SYNTHETIC_DATA_ONLY"), "true");
assert.equal(workerRuntime.get("SYNTHETIC_DATA_ONLY"), "true");
for (const secret of ["POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "MINIO_ROOT_PASSWORD"]) {
  assert.match(bootstrap.get(secret) ?? "", /^GENERATE_LOCALLY_[A-Z_]+$/, `${secret} must be a generated placeholder`);
}
for (const secret of ["S3_SECRET_ACCESS_KEY", "DATABASE_URL"]) {
  assert.match(runtime.get(secret) ?? "", /GENERATE_LOCALLY_/, `API ${secret} must be a generated placeholder`);
  assert.match(workerRuntime.get(secret) ?? "", /GENERATE_LOCALLY_/, `Worker ${secret} must be a generated placeholder`);
}
assert.doesNotMatch(`${bootstrapText}\n${runtimeText}\n${workerRuntimeText}`, /sk-[A-Za-z0-9]/, "Examples must not contain an API key");
console.log("Bootstrap and runtime environment examples are complete, synthetic-only, and credential-isolated.");
