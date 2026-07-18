import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const required = [
  "EVIDENCE_LOOP_ENV",
  "PORT",
  "SYNTHETIC_DATA_ONLY",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET_QUARANTINE",
  "S3_BUCKET_CLEAN",
  "S3_BUCKET_DERIVED",
  "ALLOWED_WEB_ORIGINS",
  "DEPLOYMENT_ID",
  "RELEASE_VERSION",
];
const text = await readFile(new URL("../infra/env/.env.example", import.meta.url), "utf8");
const entries = new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
  const index = line.indexOf("=");
  return [line.slice(0, index), line.slice(index + 1)];
}));
for (const variable of required) assert.ok(entries.has(variable), `Missing ${variable} from infra/env/.env.example`);
assert.equal(entries.get("SYNTHETIC_DATA_ONLY"), "true", "A01 examples must be synthetic-only");
for (const secret of ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "S3_SECRET_ACCESS_KEY"]) {
  const value = entries.get(secret) ?? "";
  assert.match(value, /^(?:GENERATE_LOCALLY|CHANGE_ME)(?:_[A-Z_]+)?$/, `${secret} must be a non-live placeholder`);
}
assert.doesNotMatch(text, /sk-[A-Za-z0-9]/, "Example must not contain an API key");
console.log("Environment example has all required keys and only non-live secret placeholders.");
