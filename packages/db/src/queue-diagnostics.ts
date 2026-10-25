import type { PgBoss } from "pg-boss";
import bossPackage from "pg-boss/package.json";
import { databaseDiagnostic } from "./diagnostics";

// SQL is inspected only to choose fixed labels, never logged or attached to an error.
const operations = new WeakMap<object, { operation: string; queue?: string }>();
const startupConnections = new WeakMap<PgBoss, Record<string, unknown>>();
const diagnosticQueues = [
  "__pgboss__send-it",
  "run.step",
  "maintenance.expire-paused-runs",
  "maintenance.recover-runs",
];
export function instrumentQueueDatabase(
  boss: PgBoss,
  connectionString: string,
): void {
  const db = boss.getDb();
  const execute = db.executeSql.bind(db);
  db.executeSql = async (sql, values) => {
    try {
      // 12.37.0 opens the pool before this first startup query. Observe identity
      // before create_queue can leave a pooled transaction aborted on failure.
      if (sql === "SELECT version()") {
        startupConnections.delete(boss);
        startupConnections.set(
          boss,
          await inspectQueueConnection(boss, connectionString),
        );
      }
      return await execute(sql, values);
    } catch (error) {
      if (error && typeof error === "object") {
        let operation = "queue_sql";
        // Only application-owned names, never arbitrary values/job data from a query.
        const queue = diagnosticQueues.find(
          (name) =>
            values?.includes(name) ||
            sql.includes(`pgboss.create_queue('${name}',`),
        );
        if (sql.includes("pgboss.create_queue(")) {
          operation = "queue_create";
        } else if (/\bFROM pgboss\.version\b/i.test(sql))
          operation = "queue_schema_check";
        else if (/\bFROM pgboss\.queue\b/i.test(sql))
          operation = "queue_catalog_read";
        else if (/\bINSERT INTO pgboss\.instance\b/i.test(sql))
          operation = "queue_instance_register";
        else if (/\bpgboss\.schedule\b/.test(sql)) operation = "queue_schedule";
        operations.set(error, { operation, ...(queue ? { queue } : {}) });
      }
      throw error;
    }
  };
}

export function queueDiagnostic(error: unknown) {
  return {
    ...databaseDiagnostic(error),
    ...(error && typeof error === "object" ? operations.get(error) : undefined),
  };
}

/** Read through pg-boss's ACTUAL pool, including on failed start, before stop closes it.
 * A failed diagnostic must never hide the original failure. No identities/URLs are emitted.
 */
export async function inspectQueueConnection(
  boss: PgBoss,
  connectionString: string,
) {
  const version = {
    packageVersion: bossPackage.version,
    expectedSchemaVersion: bossPackage.pgboss.schema,
  };
  try {
    const username = decodeURIComponent(new URL(connectionString).username);
    const { rows } = await boss.getDb().executeSql(
      `SELECT
      current_user = $1 AS "configuredRoleMatches",
      current_user = session_user AS "sessionRoleMatches",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
      CASE WHEN to_regnamespace('pgboss') IS NOT NULL THEN
        has_schema_privilege(current_user, 'pgboss', 'CREATE') ELSE false END AS "schemaCreate"`,
      [username],
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      ...version,
      connectionVerified: true,
      configuredRoleMatches: row.configuredRoleMatches === true,
      sessionRoleMatches: row.sessionRoleMatches === true,
      databaseCreate: row.databaseCreate === true,
      schemaCreate: row.schemaCreate === true,
    };
  } catch {
    return {
      ...version,
      connectionVerified: false,
      ...(startupConnections.has(boss)
        ? { startupConnection: startupConnections.get(boss) }
        : {}),
    };
  }
}
