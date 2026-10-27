import { PgBoss } from "pg-boss";
import bossPackage from "pg-boss/package.json";
import type { Pool } from "pg";
import { verifiedDatabaseUrl } from "../../config/env";
import type { RawSql } from "./client";
import { instrumentQueueDatabase } from "./queue-diagnostics";

/** API_CONTRACTS §8 queues. */
/**
 * A run step that runs longer than this is expired and retried by the queue while it may
 * still be calling a paid provider, so every provider deadline must fit well inside it.
 */
export const RUN_STEP_EXPIRE_SECONDS = 600;

export const QUEUES = {
  runStep: "run.step",
  expirePausedRuns: "maintenance.expire-paused-runs",
  recoverRuns: "maintenance.recover-runs",
} as const;

export const BOSS_SCHEMA = "pgboss";

/**
 * A heartbeat must reflect current queue capability, not just successful initial startup.
 * Read-only and bounded by the worker pool timeout; never consumes a job or calls providers.
 */
export async function assertQueueReady(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{
    version: number | null;
    queues: number;
    permitted: boolean;
    functions: boolean;
  }>(
    `SELECT (SELECT version FROM pgboss.version LIMIT 1) AS version,
      (SELECT count(*)::int FROM pgboss.queue WHERE name = ANY($1::text[])) AS queues,
      coalesce((SELECT bool_and(
        has_schema_privilege(current_user, n.oid, 'USAGE') AND
        has_table_privilege(current_user, c.oid, 'SELECT') AND
        has_table_privilege(current_user, c.oid, 'INSERT') AND
        has_table_privilege(current_user, c.oid, 'UPDATE') AND
        has_table_privilege(current_user, c.oid, 'DELETE'))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p')), false) AS permitted,
      (SELECT bool_and(coalesce(has_function_privilege(current_user,
        to_regprocedure(f.signature), 'EXECUTE'), false)) FROM (VALUES
        ('pgboss.create_queue(text,jsonb)'), ('pgboss.job_now()'),
        ('pg_catalog.pg_advisory_xact_lock(bigint)'), ('pg_catalog.sha224(bytea)')) AS f(signature)) AS functions`,
    [Object.values(QUEUES)],
  );
  if (rows[0]?.version !== bossPackage.pgboss.schema)
    throw new Error("pg-boss database requires migrations");
  if (rows[0]?.queues !== Object.keys(QUEUES).length)
    throw new Error("required pg-boss queues are missing");
  if (!rows[0]?.permitted || !rows[0]?.functions)
    throw Object.assign(new Error("Queue privileges unavailable"), {
      code: "42501",
    });
}

export interface RunStepJob {
  runId: string;
  expectedStateVersion: number;
}

export const runStepKey = (job: RunStepJob) =>
  `run:${job.runId}:${job.expectedStateVersion}`;

/**
 * Install the pg-boss schema and queues. DDL: called only from the release migrator (the app
 * role has no DDL rights, roles.sql) and from test database setup.
 */
export async function installQueues(connectionString: string): Promise<void> {
  const migrationUrl = new URL(verifiedDatabaseUrl(connectionString));
  migrationUrl.searchParams.set(
    "options",
    `${migrationUrl.searchParams.get("options") ?? ""} -c statement_timeout=120000 -c lock_timeout=60000`.trim(),
  );
  const boss = new PgBoss({
    connectionString: migrationUrl.toString(),
    schema: BOSS_SCHEMA,
    application_name: "tessaloom-migrate",
    max: 1,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  try {
    await boss.start();
    const ensure = async (
      name: string,
      options: Parameters<PgBoss["createQueue"]>[1],
    ) => {
      if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
    };
    // `exclusive`: one queued-or-active job per singleton key (run:<id>:<version>), so a
    // duplicate enqueue of the same step is dropped by the queue as well as by state_version.
    await ensure(QUEUES.runStep, {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 15,
      expireInSeconds: RUN_STEP_EXPIRE_SECONDS,
      deleteAfterSeconds: 7 * 86_400,
    });
    await ensure(QUEUES.expirePausedRuns, {
      policy: "singleton",
      retryLimit: 0,
    });
    await ensure(QUEUES.recoverRuns, { policy: "singleton", retryLimit: 0 });
  } finally {
    await boss.stop({ graceful: false }).catch(() => {});
  }
}

export interface BossOptions {
  /** The worker runs maintenance and cron; the web process only sends. */
  role: "worker" | "web";
  applicationName?: string;
  max?: number;
}

/** A runtime pg-boss instance. Never migrates or creates schema objects. */
export function createBoss(
  connectionString: string,
  options: BossOptions,
): PgBoss {
  const runtimeUrl = new URL(verifiedDatabaseUrl(connectionString));
  runtimeUrl.searchParams.set(
    "options",
    `${runtimeUrl.searchParams.get("options") ?? ""} -c statement_timeout=15000`.trim(),
  );
  const boss = new PgBoss({
    connectionString: runtimeUrl.toString(),
    schema: BOSS_SCHEMA,
    application_name:
      options.applicationName ?? `tessaloom-${options.role}-queue`,
    max: options.max ?? 2,
    connectionTimeoutMillis: 5_000,
    migrate: false,
    createSchema: false,
    supervise: options.role === "worker",
    schedule: options.role === "worker",
  });
  instrumentQueueDatabase(boss, connectionString);
  // Connection errors surface through the calls that need the queue; never crash the process.
  boss.on("error", () => {});
  return boss;
}

/** Enqueue the next step. With `raw`, the job commits atomically with the caller's transaction. */
export async function enqueueRunStep(
  boss: PgBoss,
  job: RunStepJob,
  raw?: RawSql,
): Promise<string | null> {
  return boss.send(
    QUEUES.runStep,
    { ...job },
    {
      singletonKey: runStepKey(job),
      ...(raw ? { db: raw } : {}),
    },
  );
}

export type { JobWithMetadata, PgBoss } from "pg-boss";
