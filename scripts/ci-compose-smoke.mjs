import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const projectName = `elci${randomBytes(5).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), "evidence-loop-compose-"));
const bootstrapFile = join(directory, ".env");
const runtimeFile = join(directory, ".env.runtime");
const postgresUser = "evidence_loop";
const postgresDatabase = "evidence_loop";
const postgresPassword = randomBytes(24).toString("hex");
const postgresAppPassword = randomBytes(24).toString("hex");
const minioPassword = randomBytes(24).toString("hex");
const accessKey = `el${randomBytes(12).toString("hex")}`;
const secretValues = [postgresPassword, postgresAppPassword, minioPassword, accessKey];
const bootstrapEnvironment = [
  "EVIDENCE_LOOP_ENV=ci",
  "SYNTHETIC_DATA_ONLY=true",
  `POSTGRES_USER=${postgresUser}`,
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `POSTGRES_DB=${postgresDatabase}`,
  "POSTGRES_PORT=55432",
  "POSTGRES_APP_USER=evidence_loop_app",
  `POSTGRES_APP_PASSWORD=${postgresAppPassword}`,
  `MINIO_ROOT_USER=${accessKey}`,
  `MINIO_ROOT_PASSWORD=${minioPassword}`,
  "MINIO_API_PORT=59000",
  "S3_BUCKET_QUARANTINE=quarantine",
  "S3_BUCKET_CLEAN=clean",
  "S3_BUCKET_DERIVED=derived",
].join("\n");
const runtimeEnvironment = [
  "EVIDENCE_LOOP_ENV=ci",
  "SYNTHETIC_DATA_ONLY=true",
  "PORT=3001",
  `DATABASE_URL=postgresql://evidence_loop_app:${postgresAppPassword}@postgres:5432/${postgresDatabase}`,
  "S3_ENDPOINT=http://minio:9000",
  "S3_REGION=us-east-1",
  `S3_ACCESS_KEY_ID=${accessKey}`,
  `S3_SECRET_ACCESS_KEY=${minioPassword}`,
  "S3_BUCKET_QUARANTINE=quarantine",
  "S3_BUCKET_CLEAN=clean",
  "S3_BUCKET_DERIVED=derived",
  "OIDC_ISSUER=http://oidc.synthetic.invalid",
  "OIDC_JWKS_URI=http://oidc.synthetic.invalid/jwks",
  "OIDC_AUDIENCE=evidence-loop-api",
  "OIDC_ORGANIZATION_CLAIM=org",
  "ALLOWED_WEB_ORIGINS=http://127.0.0.1:3000",
  `DEPLOYMENT_ID=${projectName}`,
  "RELEASE_VERSION=ci",
].join("\n");
await Promise.all([
  writeFile(bootstrapFile, `${bootstrapEnvironment}\n`, { mode: 0o600 }),
  writeFile(runtimeFile, `${runtimeEnvironment}\n`, { mode: 0o600 }),
]);

function redact(value) {
  return secretValues.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
}

function compose(args, inherit = true) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--project-name", projectName, "--env-file", bootstrapFile, ...args], {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        EVIDENCE_LOOP_ENV_FILE: bootstrapFile,
        EVIDENCE_LOOP_RUNTIME_ENV_FILE: runtimeFile,
      },
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

function run(command, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => reject(new Error(`${command} could not start: ${error.code ?? "unknown-error"}`)));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${redact(output).slice(0, 500)}`)));
  });
}

function environmentMap(service) {
  if (Array.isArray(service.environment)) return new Map(service.environment.map((entry) => entry.split("=", 2)));
  return new Map(Object.entries(service.environment ?? {}));
}

function assertConfigIsolation(configuration) {
  const services = configuration.services;
  const forbiddenRuntime = ["MIGRATION_DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "PGPASSWORD", "PGUSER"];
  for (const name of ["api", "worker"]) {
    const environment = environmentMap(services[name]);
    for (const key of forbiddenRuntime) assert.ok(!environment.has(key), `${name} compose config must not include ${key}`);
    assert.ok(environment.has("DATABASE_URL"), `${name} must receive its non-owner DATABASE_URL`);
  }
  const migration = environmentMap(services.migrate);
  assert.deepEqual([...migration.keys()].sort(), ["MIGRATION_DATABASE_URL"]);
  const roleInit = environmentMap(services["db-role-init"]);
  assert.deepEqual([...roleInit.keys()].sort(), ["PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER", "POSTGRES_APP_PASSWORD", "POSTGRES_APP_USER"]);
}

function assertActualRuntimeEnvironment(text, service) {
  const keys = new Set(text.split(/\r?\n/).map((line) => line.slice(0, line.indexOf("="))).filter(Boolean));
  for (const key of ["MIGRATION_DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "PGPASSWORD", "PGUSER"]) {
    assert.ok(!keys.has(key), `${service} runtime environment must not include ${key}`);
  }
  assert.ok(keys.has("DATABASE_URL"), `${service} must have non-owner DATABASE_URL`);
}

let primaryFailure;
try {
  const configuration = JSON.parse(await compose(["--profile", "platform", "config", "--format", "json"], false));
  assertConfigIsolation(configuration);
  await compose(["--profile", "platform", "up", "-d", "--build"]);
  const buckets = await eventually(() => compose([
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-init", "-ec",
    'mc alias set smoke http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls smoke && mc alias set anonymous http://minio:9000 >/dev/null && for bucket in "$S3_BUCKET_QUARANTINE" "$S3_BUCKET_CLEAN" "$S3_BUCKET_DERIVED"; do printf "synthetic-smoke" | mc pipe "smoke/$bucket/access-probe" >/dev/null && ! mc ls "anonymous/$bucket" >/dev/null 2>&1 && ! mc cat "anonymous/$bucket/access-probe" >/dev/null 2>&1; done',
  ], false));
  for (const bucket of ["quarantine", "clean", "derived"]) assert.match(buckets, new RegExp(`\\b${bucket}\\b`));
  const readyResult = await eventually(() => compose([
    "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", postgresUser, "-d", postgresDatabase, "-tAc", "SELECT 1",
  ], false));
  assert.equal(readyResult.trim(), "1");
  const runtimeRole = await compose([
    "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", postgresUser, "-d", postgresDatabase, "-tAc",
    "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = 'evidence_loop_app'",
  ], false);
  assert.equal(runtimeRole.trim(), "false,false");
  for (const service of ["api", "worker"]) {
    assertActualRuntimeEnvironment(await compose(["exec", "-T", service, "env"], false), service);
  }
  const testEnvironment = `DATABASE_URL=postgresql://${postgresUser}:${postgresPassword}@postgres:5432/${postgresDatabase}`;
  const testContainer = [
    "run", "--rm", "--network", `${projectName}_platform`,
    "--mount", `type=bind,source=${process.cwd()},target=/workspace`,
    "--workdir", "/workspace",
    "--env", testEnvironment,
    "node:24.12.0-bookworm-slim",
    "node", "--experimental-strip-types", "--test",
  ];
  await run("docker", [...testContainer, "packages/db/test/database.integration.ts"]);
  await run("docker", [...testContainer, "apps/api/tests/http-api.integration.ts"]);
  await eventually(() => compose([
    "exec", "-T", "api", "node", "-e",
    "Promise.all(['/health/live','/health/ready'].map(async path => { const response = await fetch('http://127.0.0.1:3001' + path); if (!response.ok) throw new Error(path); })).then(() => process.exit(0)).catch(() => process.exit(1))",
  ], false));
  console.log("Compose smoke passed: migration/bootstrap credentials are isolated from runtime containers; non-owner NOBYPASSRLS role, private buckets, API health, PostgreSQL RLS, and Fastify authorization integration checks passed.");
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
