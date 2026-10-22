import path from "node:path";
import type { PoolClient } from "pg";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseTlsAllowed } from "../../config/env";
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
  if (!databaseTlsAllowed(process.env.APP_ENV, connectionString))
    throw new Error("Invalid DATABASE_URL: TLS is required");
  const handle = createDb(connectionString, {
    max: 1,
    applicationName: "tessaloom-migrate",
    statementTimeoutMs: 120_000,
  });
  let client: PoolClient | undefined;
  try {
    client = await handle.pool.connect();
    await client.query("SET lock_timeout = '60s'");
    // One session holds the lock across both Drizzle and pg-boss installation.
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('tessaloom:migrate', 0))",
    );
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    await installQueues(connectionString);
  } finally {
    if (client) {
      await client
        .query(
          "SELECT pg_advisory_unlock(hashtextextended('tessaloom:migrate', 0))",
        )
        .catch(() => {});
      client.release();
    }
    await handle.close();
  }
}
