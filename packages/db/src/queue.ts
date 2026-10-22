import { PgBoss } from "pg-boss";
import type { RawSql } from "./client";

/** API_CONTRACTS §8 queues. */
export const QUEUES = {
  runStep: "run.step",
  expirePausedRuns: "maintenance.expire-paused-runs",
  recoverRuns: "maintenance.recover-runs",
} as const;

export const BOSS_SCHEMA = "pgboss";

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
  const migrationUrl = new URL(connectionString);
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
      expireInSeconds: 600,
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
  const boss = new PgBoss({
    connectionString,
    schema: BOSS_SCHEMA,
    application_name:
      options.applicationName ?? `tessaloom-${options.role}-queue`,
    max: options.max ?? 2,
    migrate: false,
    createSchema: false,
    supervise: options.role === "worker",
    schedule: options.role === "worker",
  });
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
