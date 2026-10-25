import { databaseTlsAllowed } from "../../config/env";
import { createDb, type DbHandle } from "./client";
import { inspectRuntimeDatabase } from "./diagnose";
import { databaseFailure, databaseDiagnostic } from "./diagnostics";

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
  let handle: DbHandle | undefined;
  try {
    handle = createDb(url, {
      max: 1,
      applicationName: "tessaloom-diagnose",
      statementTimeoutMs: 5_000,
    });
    const report = await inspectRuntimeDatabase(
      handle.pool,
      decodeURIComponent(new URL(url).username),
    );
    console.log(JSON.stringify({ event: "database_diagnostic", ...report }));
    if (
      report.elevated ||
      report.schemaCreate ||
      report.queueSchemaCreate ||
      report.databaseCreate ||
      report.configuredRoleMatches === false ||
      report.sessionRoleMatches === false ||
      !Object.values(report.checks).every(Boolean)
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "database_diagnostic_failed",
        reason: databaseFailure(error),
        ...databaseDiagnostic(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await handle?.close().catch(() => {
      console.error(
        JSON.stringify({
          event: "database_diagnostic_failed",
          reason: "connection_cleanup_failed",
        }),
      );
      process.exitCode = 1;
    });
  }
}
