import { createDatabase } from "./index.ts";
import { applyMigrations } from "./migration-runner.ts";

const url = process.env.MIGRATION_DATABASE_URL?.trim();
if (!url) {
  console.error("MIGRATION_DATABASE_URL: required");
  process.exitCode = 1;
} else {
  const { client } = createDatabase(url);
  try {
    const result = await applyMigrations(client);
    console.log(`Migrations applied: ${result.applied.length}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}
