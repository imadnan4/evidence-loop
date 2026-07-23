import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

export type MigrationResult = Readonly<{ applied: readonly string[]; skipped: readonly string[] }>;

type MigrationFile = Readonly<{ filename: string; version: number }>;

const defaultMigrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const migrationName = /^(\d+)_.+\.sql$/;

function sortMigrations(files: readonly string[]): MigrationFile[] {
  return files
    .map((filename) => {
      const match = filename.match(migrationName);
      if (!match?.[1]) return null;
      return { filename, version: Number.parseInt(match[1], 10) };
    })
    .filter((file): file is MigrationFile => file !== null)
    .sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
}

export async function applyMigrations(client: Sql<{}>, migrationDirectory = defaultMigrationDirectory): Promise<MigrationResult> {
  const files = sortMigrations(await readdir(migrationDirectory));
  const applied: string[] = [];
  const skipped: string[] = [];

  await client.begin(async (transaction) => {
    // The lock is scoped to this transaction, so a failed migration releases it and
    // another deploy cannot observe partially-applied DDL or race CREATE POLICY.
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('evidence-loop:migrations', 0))`;
    await transaction.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const { filename } of files) {
      const statement = await readFile(join(migrationDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(statement).digest("hex");
      const existing = await transaction<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE filename = ${filename}`;
      if (existing.length > 0) {
        if (existing[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${filename}`);
        skipped.push(filename);
        continue;
      }
      await transaction.unsafe(statement);
      await transaction`INSERT INTO schema_migrations (filename, checksum) VALUES (${filename}, ${checksum})`;
      applied.push(filename);
    }
  });
  return { applied, skipped };
}
