import { randomBytes } from "node:crypto";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";

const target = new URL("../infra/env/.env.local", import.meta.url);
try {
  await access(target);
  console.error("infra/env/.env.local already exists; remove it before generating a new local stack.");
  process.exit(1);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const template = await readFile(new URL("../infra/env/.env.example", import.meta.url), "utf8");
const postgresPassword = randomBytes(24).toString("hex");
const minioPassword = randomBytes(24).toString("hex");
const accessKey = `el${randomBytes(12).toString("hex")}`;
const replacements = new Map([
  ["GENERATE_LOCALLY_POSTGRES_PASSWORD", postgresPassword],
  ["GENERATE_LOCALLY_MINIO_ACCESS_KEY", accessKey],
  ["GENERATE_LOCALLY_MINIO_PASSWORD", minioPassword],
]);
let generated = template;
for (const [from, to] of replacements) generated = generated.replaceAll(from, to);
await writeFile(target, generated, { mode: 0o600 });
console.log("Created infra/env/.env.local with generated synthetic-only local credentials.");
