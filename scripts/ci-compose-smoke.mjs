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
const workerRuntimeFile = join(directory, ".env.worker.runtime");
const postgresUser = "evidence_loop";
const postgresDatabase = "evidence_loop";
const postgresPassword = randomBytes(24).toString("hex");
const postgresAppPassword = randomBytes(24).toString("hex");
const postgresWorkerPassword = randomBytes(24).toString("hex");
const minioPassword = randomBytes(24).toString("hex");
const accessKey = `el${randomBytes(12).toString("hex")}`;
const apiAccessKey = `api${randomBytes(10).toString("hex")}`;
const apiSecretKey = randomBytes(24).toString("hex");
const workerAccessKey = `wrk${randomBytes(10).toString("hex")}`;
const workerSecretKey = randomBytes(24).toString("hex");
const secretValues = [postgresPassword, postgresAppPassword, postgresWorkerPassword, minioPassword, accessKey, apiAccessKey, apiSecretKey, workerAccessKey, workerSecretKey];
const bootstrapEnvironment = [
  "EVIDENCE_LOOP_ENV=ci",
  "SYNTHETIC_DATA_ONLY=true",
  `POSTGRES_USER=${postgresUser}`,
  `POSTGRES_PASSWORD=${postgresPassword}`,
  `POSTGRES_DB=${postgresDatabase}`,
  "POSTGRES_PORT=55432",
  "POSTGRES_APP_USER=evidence_loop_app",
  `POSTGRES_APP_PASSWORD=${postgresAppPassword}`,
  "POSTGRES_WORKER_USER=evidence_loop_worker",
  `POSTGRES_WORKER_PASSWORD=${postgresWorkerPassword}`,
  `MINIO_ROOT_USER=${accessKey}`,
  `MINIO_ROOT_PASSWORD=${minioPassword}`,
  "MINIO_API_PORT=59000",
  "S3_BUCKET_QUARANTINE=quarantine",
  "S3_BUCKET_CLEAN=clean",
  "S3_BUCKET_DERIVED=derived",
  `MINIO_API_ACCESS_KEY=${apiAccessKey}`,
  `MINIO_API_SECRET_KEY=${apiSecretKey}`,
  `MINIO_WORKER_ACCESS_KEY=${workerAccessKey}`,
  `MINIO_WORKER_SECRET_KEY=${workerSecretKey}`,
].join("\n");
const runtimeEnvironment = [
  "EVIDENCE_LOOP_ENV=ci",
  "SYNTHETIC_DATA_ONLY=true",
  "PORT=3001",
  `DATABASE_URL=postgresql://evidence_loop_app:${postgresAppPassword}@postgres:5432/${postgresDatabase}`,
  "S3_ENDPOINT=http://minio:9000",
  "S3_REGION=us-east-1",
  `S3_ACCESS_KEY_ID=${apiAccessKey}`,
  `S3_SECRET_ACCESS_KEY=${apiSecretKey}`,
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
const workerRuntimeEnvironment = `${runtimeEnvironment.replace(`evidence_loop_app:${postgresAppPassword}`, `evidence_loop_worker:${postgresWorkerPassword}`).replace(`S3_ACCESS_KEY_ID=${apiAccessKey}`, `S3_ACCESS_KEY_ID=${workerAccessKey}`).replace(`S3_SECRET_ACCESS_KEY=${apiSecretKey}`, `S3_SECRET_ACCESS_KEY=${workerSecretKey}`)}\nCLAMD_SOCKET=/run/clamav/clamd.sock\nCLAMD_SIGNATURE_DIRECTORY=/var/lib/clamav\nCLAMD_MAX_SIGNATURE_AGE_SECONDS=86400`;
await Promise.all([
  writeFile(bootstrapFile, `${bootstrapEnvironment}\n`, { mode: 0o600 }),
  writeFile(runtimeFile, `${runtimeEnvironment}\n`, { mode: 0o600 }),
  writeFile(workerRuntimeFile, `${workerRuntimeEnvironment}\n`, { mode: 0o600 }),
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
        EVIDENCE_LOOP_WORKER_RUNTIME_ENV_FILE: workerRuntimeFile,
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
      else reject(new Error(`docker compose ${args[0] ?? "command"} failed (${code ?? "unknown"}): ${redact(output).slice(0, 5000)}`));
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
      : reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${redact(output).slice(0, 5000)}`)));
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
  assert.deepEqual([...roleInit.keys()].sort(), ["PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER", "POSTGRES_APP_PASSWORD", "POSTGRES_APP_USER", "POSTGRES_WORKER_PASSWORD", "POSTGRES_WORKER_USER"]);
}

function assertActualRuntimeEnvironment(text, service) {
  const keys = new Set(text.split(/\r?\n/).map((line) => line.slice(0, line.indexOf("="))).filter(Boolean));
  for (const key of ["MIGRATION_DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_APP_USER", "POSTGRES_APP_PASSWORD", "POSTGRES_WORKER_USER", "POSTGRES_WORKER_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "PGPASSWORD", "PGUSER"]) {
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
  for (const runtimeRoleName of ["evidence_loop_app", "evidence_loop_worker"]) {
    const runtimeRole = await compose([
      "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "-U", postgresUser, "-d", postgresDatabase, "-tAc",
      `SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = '${runtimeRoleName}'`,
    ], false);
    assert.equal(runtimeRole.trim(), "false,false", `${runtimeRoleName} must remain a non-owner NOBYPASSRLS role`);
  }
  const apiEnvironment = await compose(["exec", "-T", "api", "env"], false);
  const workerEnvironment = await compose(["exec", "-T", "worker", "env"], false);
  assertActualRuntimeEnvironment(apiEnvironment, "api");
  assertActualRuntimeEnvironment(workerEnvironment, "worker");
  assert.match(apiEnvironment, new RegExp(`^S3_ACCESS_KEY_ID=${apiAccessKey}$`, "m"));
  assert.match(workerEnvironment, new RegExp(`^S3_ACCESS_KEY_ID=${workerAccessKey}$`, "m"));
  assert.doesNotMatch(apiEnvironment, new RegExp(workerAccessKey));
  assert.doesNotMatch(workerEnvironment, new RegExp(apiAccessKey));
  // Presence/readability only: no signature filename, content, or host path is emitted.
  await eventually(() => compose(["exec", "-T", "worker", "/bin/sh", "-ec", "test -S /run/clamav/clamd.sock && test -r /var/lib/clamav"], false));
  // Exercise the deployed Unix-socket INSTREAM path. The worker's normal
  // handler maps this FOUND verdict to rejected before parser/promotion; this
  // probe never supplies an artifact key or any storage capability.
  const eicarSocketProbe = `const net=require("node:net");const data=Buffer.from("X5O!P%@AP[4\\\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*");const socket=net.createConnection({path:"/run/clamav/clamd.sock"});let reply="";const timer=setTimeout(()=>fail(),30000);const fail=()=>{clearTimeout(timer);socket.destroy();process.exit(1)};socket.once("error",fail);socket.on("data",chunk=>{reply+=chunk; if(/[\\0\\n]/.test(reply)){clearTimeout(timer);socket.destroy();process.exit(/: [^\\0\\n]+ FOUND[\\0\\n]*$/.test(reply)?0:1)}});socket.once("connect",()=>{socket.write(Buffer.from("zINSTREAM\\0"));const n=Buffer.alloc(4);n.writeUInt32BE(data.length);socket.write(n);socket.write(data);socket.write(Buffer.alloc(4))});`;
  await compose(["exec", "-T", "worker", "node", "-e", eicarSocketProbe], false);
  // Exercise the actual service-account policies without printing credentials.
  // The probes use the same q/c/d prefixes hard-coded by PrivateS3Storage.
  await compose([
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "-e", `MINIO_ROOT_USER=${apiAccessKey}`, "-e", `MINIO_ROOT_PASSWORD=${apiSecretKey}`, "minio-init", "-ec",
    'mc alias set scoped http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; printf x | mc pipe scoped/quarantine/q/iam-probe >/dev/null; ! mc cat scoped/quarantine/q/iam-probe >/dev/null 2>&1; ! sh -c "printf x | mc pipe scoped/clean/c/api-denied >/dev/null"; ! sh -c "printf x | mc pipe scoped/derived/d/api-denied >/dev/null"',
  ], false);
  await compose([
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "-e", `MINIO_ROOT_USER=${workerAccessKey}`, "-e", `MINIO_ROOT_PASSWORD=${workerSecretKey}`, "minio-init", "-ec",
    'mc alias set scoped http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc cat scoped/quarantine/q/iam-probe >/dev/null; printf x | mc pipe scoped/clean/c/iam-probe >/dev/null; printf x | mc pipe scoped/derived/d/iam-probe >/dev/null; ! sh -c "printf x | mc pipe scoped/quarantine/q/worker-denied >/dev/null"; ! mc cat scoped/clean/c/iam-probe >/dev/null 2>&1; ! mc cat scoped/derived/d/iam-probe >/dev/null 2>&1',
  ], false);
  await compose([
    "exec", "-T", "postgres", "/bin/sh", "-ec",
    `PGPASSWORD='${postgresWorkerPassword}' psql -X -v ON_ERROR_STOP=1 -U evidence_loop_worker -d ${postgresDatabase} -c 'SELECT id FROM artifacts' >/dev/null 2>&1 && exit 1 || exit 0`,
  ], false);
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
