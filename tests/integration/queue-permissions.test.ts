import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  assertQueueReady,
  createBoss,
  createDb,
  databaseFailure,
  inspectQueueConnection,
  queueDiagnostic,
  QUEUES,
} from "../../packages/db/src";
import { inspectRuntimeDatabase } from "../../packages/db/src/diagnose";
import { checkReadiness } from "../../apps/web/src/lib/readiness";
import { createTestDatabase } from "./helpers/test-db";

async function fixture() {
  const test = await createTestDatabase();
  const role = `tl_queue_${randomUUID().replaceAll("-", "")}`;
  await test.handle.pool
    .query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-test-only'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public, pgboss TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO "${role}";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}";
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO "${role}"`);
  const url = new URL(test.url);
  url.username = role;
  url.password = "local-test-only";
  const runtime = createDb(url.toString());
  const boss = createBoss(url.toString(), { role: "worker" });
  return {
    ...test,
    role,
    runtime,
    boss,
    runtimeUrl: url.toString(),
    cleanup: async () => {
      await boss.stop({ graceful: false });
      await runtime.close();
      await test.drop();
      const admin = createDb(process.env.DATABASE_URL!);
      try {
        await admin.pool.query(`DROP ROLE "${role}"`);
      } finally {
        await admin.close();
      }
    },
  };
}

async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 25_000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Queue regression timed out");
}

it("schema 45 needs no runtime CREATE or ownership for existing/new shared queues, processing and restart", async () => {
  const t = await fixture();
  try {
    // All schema tables/functions are owned by the admin, not the runtime role.
    expect(
      (
        await t.handle.pool.query(
          `SELECT bool_and(tableowner <> $1) AS admin_owned
      FROM pg_tables WHERE schemaname = 'pgboss'`,
          [t.role],
        )
      ).rows[0].admin_owned,
    ).toBe(true);
    await t.boss.start();
    expect(await inspectQueueConnection(t.boss, t.runtimeUrl)).toMatchObject({
      packageVersion: "12.37.0",
      expectedSchemaVersion: 45,
      connectionVerified: true,
      configuredRoleMatches: true,
      sessionRoleMatches: true,
      databaseCreate: false,
      schemaCreate: false,
    });
    const report = await inspectRuntimeDatabase(t.runtime.pool, t.role);
    expect(report.schemaVersion).toBe(45);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    // Existing queue call, including the internal scheduler queue: no index/partition DDL.
    for (const name of [...Object.values(QUEUES), "__pgboss__send-it"])
      await t.boss.createQueue(name);
    // Missing nonpartitioned queues are INSERT-only in this exact version.
    await t.boss.createQueue("permission.regression");
    let consumed = 0;
    await t.boss.work(
      "permission.regression",
      { pollingIntervalSeconds: 0.5 },
      async () => {
        consumed++;
      },
    );
    const first = await t.boss.send("permission.regression", {
      marker: "local-only",
    });
    await until(
      async () =>
        (await t.boss.getJobById("permission.regression", first!))?.state ===
        "completed",
    );
    await t.boss.schedule(QUEUES.recoverRuns, "*/5 * * * *");
    await t.boss.supervise();
    await assertQueueReady(t.runtime.pool);
    await expect(
      t.runtime.pool.query("CREATE TABLE pgboss.forbidden(id int)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      t.boss.createQueue("partition.forbidden", { partition: true }),
    ).rejects.toMatchObject({ code: "42501" });
    await t.boss.stop({ graceful: true });
    await t.boss.start();
    await t.boss.work(
      "permission.regression",
      { pollingIntervalSeconds: 0.5 },
      async () => {
        consumed++;
      },
    );
    const second = await t.boss.send("permission.regression");
    await until(
      async () =>
        (await t.boss.getJobById("permission.regression", second!))?.state ===
        "completed",
    );
    expect(consumed).toBe(2);
    expect(await t.boss.getSchedules()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: QUEUES.recoverRuns }),
      ]),
    );
    expect(
      (await t.boss.getJobById("permission.regression", first!))?.state,
    ).toBe("completed");
  } finally {
    await t.cleanup();
  }
});

it("identifies the actual denied function at queue_connect and detects version/role drift", async () => {
  const t = await fixture();
  try {
    await t.handle.pool.query(
      `REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) FROM PUBLIC, "${t.role}"`,
    );
    let failure: unknown;
    try {
      await t.boss.start();
    } catch (error) {
      failure = error;
    }
    expect(databaseFailure(failure)).toBe("permission_denied");
    expect(queueDiagnostic(failure)).toMatchObject({
      operation: "queue_create",
      queue: "__pgboss__send-it",
      sqlstate: "42501",
      message: "permission denied for function create_queue",
      routine: "aclcheck_error",
      retryClassification: "operator_action_required",
    });
    const connection = await inspectQueueConnection(t.boss, t.runtimeUrl);
    expect(
      connection.connectionVerified
        ? connection
        : "startupConnection" in connection
          ? connection.startupConnection
          : null,
    ).toMatchObject({
      configuredRoleMatches: true,
      sessionRoleMatches: true,
      databaseCreate: false,
      schemaCreate: false,
    });
    expect(
      (await inspectRuntimeDatabase(t.runtime.pool, t.role)).checks
        .createQueueExecute,
    ).toBe(false);
    await expect(assertQueueReady(t.runtime.pool)).rejects.toMatchObject({
      code: "42501",
    });
    await t.boss.stop({ graceful: false });
    await t.handle.pool.query(
      `GRANT EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) TO "${t.role}"`,
    );
    await t.boss.start();
    const wrongUrl = new URL(t.runtimeUrl);
    wrongUrl.username = "different-inspected-role";
    expect(
      await inspectQueueConnection(t.boss, wrongUrl.toString()),
    ).toMatchObject({ configuredRoleMatches: false });
    await t.handle.pool.query(
      `REVOKE INSERT ON pgboss.schedule FROM "${t.role}"`,
    );
    let scheduleFailure: unknown;
    try {
      await t.boss.schedule(QUEUES.recoverRuns, "*/5 * * * *");
    } catch (error) {
      scheduleFailure = error;
    }
    expect(queueDiagnostic(scheduleFailure)).toMatchObject({
      sqlstate: "42501",
      operation: "queue_schedule",
      queue: QUEUES.recoverRuns,
      message: "permission denied for table schedule",
    });
    await t.handle.pool.query(`GRANT INSERT ON pgboss.schedule TO "${t.role}"`);
    await t.boss.stop({ graceful: false });
    for (const version of [44, 46]) {
      await t.handle.pool.query("UPDATE pgboss.version SET version = $1", [
        version,
      ]);
      await expect(t.boss.start()).rejects.toThrow(
        "pg-boss database requires migrations",
      );
      expect(
        (await inspectRuntimeDatabase(t.runtime.pool)).checks
          .queueSchemaCompatible,
      ).toBe(false);
      await t.boss.stop({ graceful: false });
    }
    await t.handle.pool.query("UPDATE pgboss.version SET version = 45");
    await t.handle.pool.query("DELETE FROM pgboss.queue WHERE name = $1", [
      QUEUES.runStep,
    ]);
    await expect(assertQueueReady(t.runtime.pool)).rejects.toThrow(
      "required pg-boss queues are missing",
    );
  } finally {
    await t.cleanup();
  }
});

it("real DML-only worker retries permission failure, processes jobs, loses readiness on EXECUTE revoke, then recovers", async () => {
  const t = await fixture();
  const id = randomUUID();
  let output = "";
  await t.handle.pool.query(
    `REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) FROM PUBLIC, "${t.role}"`,
  );
  const child = spawn(process.execPath, ["apps/worker/dist/main.js"], {
    env: {
      APP_ENV: "test",
      NODE_ENV: "production",
      DATABASE_URL: t.runtimeUrl,
      TL_HEARTBEAT_ID: id,
      RUN_ACCESS: "off",
      GLOBAL_DAILY_LLM_USD: "0",
      GLOBAL_DAILY_QLOO_CALLS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    await until(() => output.includes('"event":"worker_queue_start_failed"'));
    const event = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "worker_queue_start_failed");
    expect(event).toMatchObject({
      stage: "queue_connect",
      reason: "permission_denied",
      sqlstate: "42501",
      operation: "queue_create",
      queue: "__pgboss__send-it",
      retryMs: 15_000,
    });
    expect(await checkReadiness(t.runtimeUrl, 30, id)).toEqual({
      db: true,
      worker: false,
    });
    await t.handle.pool.query(
      `GRANT EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) TO "${t.role}"`,
    );
    await until(
      async () => (await checkReadiness(t.runtimeUrl, 30, id)).worker,
    );
    await t.boss.start();
    const job = await t.boss.send(QUEUES.expirePausedRuns);
    await until(
      async () =>
        (await t.boss.getJobById(QUEUES.expirePausedRuns, job!))?.state ===
        "completed",
    );
    await t.handle.pool.query(
      `REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) FROM "${t.role}"`,
    );
    await until(() => output.includes('"event":"worker_heartbeat_failed"'));
    await until(
      async () => !(await checkReadiness(t.runtimeUrl, 30, id)).worker,
      35_000,
    );
    await t.handle.pool.query(
      `GRANT EXECUTE ON FUNCTION pgboss.create_queue(text,jsonb) TO "${t.role}"`,
    );
    await until(
      async () => (await checkReadiness(t.runtimeUrl, 30, id)).worker,
    );
    expect(output).toContain("worker_heartbeat_recovered");
    expect(output).not.toContain(t.runtimeUrl);
    expect(output).not.toContain("local-test-only");
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
    expect(output).toContain("worker_stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await t.cleanup();
  }
}, 90_000);
