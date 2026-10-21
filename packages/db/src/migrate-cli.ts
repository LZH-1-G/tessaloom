import { runMigrations } from "./migrate";

// Entry point for the bundled release-step migrator (dist/migrate.mjs) only. Kept separate from
// migrate.ts so that bundling the library elsewhere (e.g. the worker) never runs migrations.
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
    // Never log the connection string; report only the error code.
    const code =
      (error as { code?: string; cause?: { code?: string } }).cause?.code ??
      (error as { code?: string }).code;
    console.error(
      JSON.stringify({ event: "migrations_failed", code: code ?? "unknown" }),
    );
    process.exit(1);
  },
);
