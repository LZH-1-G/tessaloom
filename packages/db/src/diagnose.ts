import type { Pool } from "pg";
import { QUEUES } from "./queue";
import bossPackage from "pg-boss/package.json";

/** Read-only catalog checks; never returns identifiers, data rows or connection details. */
export async function inspectRuntimeDatabase(
  pool: Pool,
  expectedRole?: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const connection = await client.query<{
      tls: boolean;
      elevated: boolean;
      schemaCreate: boolean;
      queueSchemaCreate: boolean;
      databaseCreate: boolean;
      configuredRoleMatches: boolean | null;
      sessionRoleMatches: boolean;
    }>(
      `SELECT
      coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls,
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated,
      has_schema_privilege(current_user, 'public', 'CREATE') AS "schemaCreate",
      CASE WHEN to_regnamespace('pgboss') IS NOT NULL THEN
        has_schema_privilege(current_user, 'pgboss', 'CREATE') ELSE false END AS "queueSchemaCreate",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
      current_user = $1 AS "configuredRoleMatches",
      current_user = session_user AS "sessionRoleMatches"
      FROM pg_roles WHERE rolname = current_user`,
      [expectedRole ?? null],
    );
    const checks: Record<string, boolean> = {};
    for (const [name, table] of Object.entries({
      workerHeartbeat: "public.worker_heartbeats",
      promptRegistry: "public.prompt_templates",
      spendLedger: "public.llm_spend_reservations",
      queueVersion: "pgboss.version",
      queueDefinitions: "pgboss.queue",
      queueJobs: "pgboss.job",
      queueSchedules: "pgboss.schedule",
    })) {
      const { rows } = await client.query<{ present: boolean; dml: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present,
         CASE WHEN to_regclass($1) IS NOT NULL THEN
          has_table_privilege(current_user, to_regclass($1), 'SELECT') AND
          has_table_privilege(current_user, to_regclass($1), 'INSERT') AND
          has_table_privilege(current_user, to_regclass($1), 'UPDATE') AND
          has_table_privilege(current_user, to_regclass($1), 'DELETE')
         ELSE false END AS dml`,
        [table],
      );
      checks[`${name}Present`] = rows[0]?.present === true;
      checks[`${name}Dml`] = rows[0]?.dml === true;
    }
    // Check every privilege separately: a comma-separated privilege list means ANY.
    const { rows: rights } = await client.query<{ allowed: boolean }>(`
      SELECT coalesce(bool_and(has_schema_privilege(current_user, n.oid, 'USAGE') AND
        has_table_privilege(current_user, c.oid, 'SELECT') AND
        has_table_privilege(current_user, c.oid, 'INSERT') AND
        has_table_privilege(current_user, c.oid, 'UPDATE') AND
        has_table_privilege(current_user, c.oid, 'DELETE')), false) AS allowed
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'pgboss') AND c.relkind IN ('r','p')`);
    checks.allTablesDml = rights[0]?.allowed === true;
    if (checks.queueDefinitionsDml) {
      const { rows } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pgboss.queue WHERE name = ANY($1::text[])",
        [Object.values(QUEUES)],
      );
      checks.requiredQueues = rows[0]?.count === Object.keys(QUEUES).length;
    } else checks.requiredQueues = false;
    let schemaVersion: number | null = null;
    if (checks.queueVersionDml) {
      const { rows } = await client.query<{ version: number }>(
        "SELECT version FROM pgboss.version LIMIT 1",
      );
      schemaVersion = rows[0]?.version ?? null;
    }
    checks.queueSchemaCompatible = schemaVersion === bossPackage.pgboss.schema;
    for (const [name, signature] of Object.entries({
      createQueue: "pgboss.create_queue(text,jsonb)",
      jobClock: "pgboss.job_now()",
      advisoryLock: "pg_catalog.pg_advisory_xact_lock(bigint)",
      advisoryHash: "pg_catalog.sha224(bytea)",
    })) {
      const { rows } = await client.query<{ allowed: boolean }>(
        "SELECT coalesce(has_function_privilege(current_user, to_regprocedure($1), 'EXECUTE'), false) AS allowed",
        [signature],
      );
      checks[`${name}Execute`] = rows[0]?.allowed === true;
    }
    await client.query("COMMIT");
    return {
      ...connection.rows[0],
      packageVersion: bossPackage.version,
      expectedSchemaVersion: bossPackage.pgboss.schema,
      schemaVersion,
      checks,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
