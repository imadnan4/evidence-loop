import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export * from "./schema.ts";
export * from "./migration-runner.ts";
export * from "./transactions.ts";

/** Creates a server-only PostgreSQL client. Never call this from browser code. */
export function createDatabase(connectionString: string, options: postgres.Options<never> = {}) {
  const client = postgres(connectionString, { max: 10, prepare: false, ...options });
  return { client, db: drizzle(client) };
}

export type DatabaseClient = Sql<{}>;
