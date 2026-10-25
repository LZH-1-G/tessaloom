import { databaseTlsAllowed } from "../../config/env";
import { createDb } from "./client";
import { inspectRuntimeDatabase } from "./diagnose";
import { databaseFailure } from "./diagnostics";

// Safe in the service shell: runtime URL only, no migrations, no queue consumers/providers.
const url = process.env.DATABASE_URL;
if (!url || !databaseTlsAllowed(process.env.APP_ENV, url)) {
  console.error(
    JSON.stringify({
      event: "database_diagnostic_failed",
      reason: "invalid_database_configuration",
    }),
  );
  process.exitCode = 1;
} else {
  const handle = createDb(url, {
    max: 1,
    applicationName: "tessaloom-diagnose",
    statementTimeoutMs: 5_000,
  });
  try {
    const report = await inspectRuntimeDatabase(handle.pool);
    console.log(JSON.stringify({ event: "database_diagnostic", ...report }));
    if (
      report.elevated ||
      report.schemaCreate ||
      !Object.values(report.checks).every(Boolean)
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "database_diagnostic_failed",
        reason: databaseFailure(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}
