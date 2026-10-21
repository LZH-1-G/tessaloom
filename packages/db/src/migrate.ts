import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/** Apply all pending migrations (forward-only). Use the migrator credential. */
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
}
