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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      JSON.stringify({
        event: "migrate_config_invalid",
        missing: "DATABASE_URL_MIGRATOR",
      }),
    );
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log(JSON.stringify({ event: "migrations_applied" })),
    (error: unknown) => {
      // Never log the connection string; report only the error class and code.
      const code = (error as { code?: string }).code;
      console.error(
        JSON.stringify({ event: "migrations_failed", code: code ?? "unknown" }),
      );
      process.exit(1);
    },
  );
}
