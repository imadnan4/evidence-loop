import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";

const bootstrapTarget = new URL("../infra/env/.env.local", import.meta.url);
const runtimeTarget = new URL("../infra/env/.env.runtime.local", import.meta.url);
const workerRuntimeTarget = new URL("../infra/env/.env.worker.runtime.local", import.meta.url);
for (const target of [bootstrapTarget, runtimeTarget, workerRuntimeTarget]) {
  try {
    await access(target);
    console.error(`${target.pathname} already exists; remove both local environment files before generating a new stack.`);
    process.exit(1);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const [bootstrapTemplate, runtimeTemplate, workerRuntimeTemplate] = await Promise.all([
  readFile(new URL("../infra/env/.env.example", import.meta.url), "utf8"),
  readFile(new URL("../infra/env/.env.runtime.example", import.meta.url), "utf8"),
  readFile(new URL("../infra/env/.env.worker.runtime.example", import.meta.url), "utf8"),
]);
const postgresPassword = randomBytes(24).toString("hex");
const postgresAppPassword = randomBytes(24).toString("hex");
const postgresWorkerPassword = randomBytes(24).toString("hex");
const minioPassword = randomBytes(24).toString("hex");
const accessKey = `el${randomBytes(12).toString("hex")}`;
const apiAccessKey = `ela${randomBytes(11).toString("hex")}`;
const workerAccessKey = `elw${randomBytes(11).toString("hex")}`;
const apiSecret = randomBytes(24).toString("hex");
const workerSecret = randomBytes(24).toString("hex");
const replacements = new Map([
  ["GENERATE_LOCALLY_POSTGRES_PASSWORD", postgresPassword],
  ["GENERATE_LOCALLY_POSTGRES_APP_PASSWORD", postgresAppPassword],
  ["GENERATE_LOCALLY_POSTGRES_WORKER_PASSWORD", postgresWorkerPassword],
  ["GENERATE_LOCALLY_MINIO_ACCESS_KEY", accessKey],
  ["GENERATE_LOCALLY_MINIO_PASSWORD", minioPassword],
  ["GENERATE_LOCALLY_MINIO_API_ACCESS_KEY", apiAccessKey],
  ["GENERATE_LOCALLY_MINIO_API_SECRET_KEY", apiSecret],
  ["GENERATE_LOCALLY_MINIO_WORKER_ACCESS_KEY", workerAccessKey],
  ["GENERATE_LOCALLY_MINIO_WORKER_SECRET_KEY", workerSecret],
]);
function materialize(template) {
  let output = template;
  for (const [from, to] of replacements) output = output.replaceAll(from, to);
  return output;
}
await Promise.all([
  writeFile(bootstrapTarget, materialize(bootstrapTemplate), { mode: 0o600 }),
  writeFile(runtimeTarget, materialize(runtimeTemplate), { mode: 0o600 }),
  writeFile(workerRuntimeTarget, materialize(workerRuntimeTemplate), { mode: 0o600 }),
]);
console.log("Created separate bootstrap/migration and runtime-only synthetic local environments.");
