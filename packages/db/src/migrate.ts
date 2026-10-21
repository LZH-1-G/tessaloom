import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";
import { installQueues } from "./queue";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/**
 * Apply all pending migrations (forward-only), then install the pg-boss schema and queues.
 * Use the migrator credential: both steps need DDL.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, {
    max: 1,
    applicationName: "tessaloom-migrate",
  });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
  await installQueues(connectionString);
}
