import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createBoss,
  createDb,
  runMigrations,
  QUEUES,
  databaseFailure,
} from "../../packages/db/src";
import { inspectRuntimeDatabase } from "../../packages/db/src/diagnose";
import { checkReadiness } from "../../apps/web/src/lib/readiness";
import { createTestDatabase } from "./helpers/test-db";

it("reproduces missing pg-boss, recovers after an explicit idempotent release migration", async () => {
  const test = await createTestDatabase({ migrate: async () => {} });
  const boss = createBoss(test.url, { role: "worker" });
  try {
    expect(await checkReadiness(test.url)).toEqual({ db: true, worker: false });
    await expect(boss.start()).rejects.toThrow("pg-boss is not installed");
    await boss.stop({ graceful: false });
    await runMigrations(test.url);
    await runMigrations(test.url);
    await boss.start();
    for (const queue of Object.values(QUEUES))
      expect(await boss.getQueue(queue)).toBeTruthy();
    const migrations = await test.handle.pool.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    expect(migrations.rows[0].count).toBe(8);
    const report = await inspectRuntimeDatabase(test.handle.pool);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.elevated).toBe(true); // diagnostic flags unsafe admin credentials
    await boss.stop({ graceful: false });
    await test.handle.pool.query("UPDATE pgboss.version SET version = 0");
    await expect(boss.start()).rejects.toSatisfy(
      (error: unknown) =>
        databaseFailure(error) === "queue_schema_version_mismatch",
    );
  } finally {
    await boss.stop({ graceful: false });
    await test.drop();
  }
});

it("distinguishes missing queue privileges and succeeds with a DML-only runtime role", async () => {
  const test = await createTestDatabase();
  const role = `tl_nf_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(test.url);
  url.username = role;
  url.password = "local-test-only";
  let runtime: ReturnType<typeof createDb> | undefined;
  let boss: ReturnType<typeof createBoss> | undefined;
  try {
    await test.handle.pool.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'local-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    runtime = createDb(url.toString());
    boss = createBoss(url.toString(), { role: "worker" });
    await expect(boss.start()).rejects.toSatisfy(
      (error: unknown) => databaseFailure(error) === "permission_denied",
    );
    await boss.stop({ graceful: false });
    await test.handle.pool
      .query(`GRANT USAGE ON SCHEMA public, pgboss TO "${role}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO "${role}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, pgboss TO "${role}"`);
    await boss.start();
    await boss.work(QUEUES.runStep, async () => {});
    await boss.schedule(QUEUES.recoverRuns, "*/5 * * * *");
    expect((await inspectRuntimeDatabase(runtime.pool)).elevated).toBe(false);
    expect(
      (await inspectRuntimeDatabase(runtime.pool)).checks.allTablesDml,
    ).toBe(true);
    await expect(
      runtime.pool.query("CREATE TABLE public.nf_forbidden(id int)"),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await boss?.stop({ graceful: false });
    await runtime?.close();
    await test.drop();
    const admin = createDb(process.env.DATABASE_URL!);
    await admin.pool.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.close();
  }
});

it("a real keyless worker retries an unmigrated database, becomes ready after migration, and shuts down", async () => {
  const test = await createTestDatabase({ migrate: async () => {} });
  const id = randomUUID();
  const child = spawn(process.execPath, ["apps/worker/dist/main.js"], {
    env: {
      APP_ENV: "test",
      NODE_ENV: "production",
      DATABASE_URL: test.url,
      TL_HEARTBEAT_ID: id,
      RUN_ACCESS: "off",
      GLOBAL_DAILY_LLM_USD: "0",
      GLOBAL_DAILY_QLOO_CALLS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 250; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Worker lifecycle check timed out");
  };
  try {
    await until(() => output.includes('"reason":"queue_schema_missing"'));
    expect(await checkReadiness(test.url, 30, id)).toEqual({
      db: true,
      worker: false,
    });
    await runMigrations(test.url);
    await until(async () => (await checkReadiness(test.url, 30, id)).worker);
    expect(output).toContain('"llm":"unconfigured"');
    expect(output).not.toContain(test.url);
    expect((await checkReadiness(test.url, 30, randomUUID())).worker).toBe(
      false,
    );
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
    await test.drop();
  }
}, 40_000);
