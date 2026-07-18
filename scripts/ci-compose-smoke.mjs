import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const projectName = `elci${randomBytes(5).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), "evidence-loop-compose-"));
const environmentFile = join(directory, ".env");
const postgresPassword = randomBytes(24).toString("hex");
const minioPassword = randomBytes(24).toString("hex");
const accessKey = `el${randomBytes(12).toString("hex")}`;
const secretValues = [postgresPassword, minioPassword, accessKey];
const environment = [
  "EVIDENCE_LOOP_ENV=ci",
  "SYNTHETIC_DATA_ONLY=true",
  "PORT=3001",
  "POSTGRES_USER=evidence_loop",
  `POSTGRES_PASSWORD=${postgresPassword}`,
  "POSTGRES_DB=evidence_loop",
  "POSTGRES_PORT=55432",
  `DATABASE_URL=postgresql://evidence_loop:${postgresPassword}@127.0.0.1:55432/evidence_loop`,
  `MINIO_ROOT_USER=${accessKey}`,
  `MINIO_ROOT_PASSWORD=${minioPassword}`,
  "MINIO_API_PORT=59000",
  "S3_ENDPOINT=http://127.0.0.1:59000",
  "S3_REGION=us-east-1",
  `S3_ACCESS_KEY_ID=${accessKey}`,
  `S3_SECRET_ACCESS_KEY=${minioPassword}`,
  "S3_BUCKET_QUARANTINE=quarantine",
  "S3_BUCKET_CLEAN=clean",
  "S3_BUCKET_DERIVED=derived",
  "ALLOWED_WEB_ORIGINS=http://127.0.0.1:3000",
  `DEPLOYMENT_ID=${projectName}`,
  "RELEASE_VERSION=ci",
].join("\n");
await writeFile(environmentFile, `${environment}\n`, { mode: 0o600 });

function redact(value) {
  return secretValues.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
}

function compose(args, inherit = true) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--project-name", projectName, "--env-file", environmentFile, ...args], {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, EVIDENCE_LOOP_ENV_FILE: environmentFile },
    });
    let output = "";
    if (!inherit) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", (error) => reject(new Error(`docker compose could not start: ${error.code ?? "unknown-error"}`)));
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`docker compose ${args[0] ?? "command"} failed (${code ?? "unknown"}): ${redact(output).slice(0, 500)}`));
    });
  });
}

async function eventually(operation) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

let primaryFailure;
try {
  // Do not use the checked-in local environment: this stack receives credentials
  // only from the mode-0600 temporary file above.
  await compose(["up", "-d"]);
  const buckets = await eventually(() => compose([
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-init", "-ec",
    'mc alias set smoke http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls smoke && mc alias set anonymous http://minio:9000 >/dev/null && for bucket in "$S3_BUCKET_QUARANTINE" "$S3_BUCKET_CLEAN" "$S3_BUCKET_DERIVED"; do printf "synthetic-smoke" | mc pipe "smoke/$bucket/access-probe" >/dev/null && ! mc ls "anonymous/$bucket" >/dev/null 2>&1 && ! mc cat "anonymous/$bucket/access-probe" >/dev/null 2>&1; done',
  ], false));
  for (const bucket of ["quarantine", "clean", "derived"]) assert.match(buckets, new RegExp(`\\b${bucket}\\b`));
  console.log("Compose smoke passed: dependencies healthy, private buckets provisioned, and anonymous listing/read access denied for every object zone.");
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  try {
    await compose(["down", "--volumes", "--remove-orphans"]);
  } catch (error) {
    if (!primaryFailure) throw error;
    console.error(`Compose cleanup failed after test failure: ${redact(error).slice(0, 500)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
