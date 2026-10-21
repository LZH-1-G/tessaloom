import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { GET as liveness } from "../../apps/web/src/app/api/health/route";
import { GET as readiness } from "../../apps/web/src/app/api/health/ready/route";
import { beatWorker, sql, type DbHandle } from "../../packages/db/src";
import { createTestDatabase } from "./helpers/test-db";

let handle: DbHandle;
let url: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  url = test.url;
  drop = test.drop;
});
afterAll(async () => {
  await drop?.();
});
afterEach(() => vi.unstubAllEnvs());

it("returns liveness without database access", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://invalid@127.0.0.1:1/unavailable");
  const response = liveness();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version: "0.0.0" });
});

it("reports a reachable but unmigrated database as not ready (no worker)", async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for integration tests");
  const response = await readiness();
  // The admin database has no heartbeat table: db is up, the worker is not.
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ db: true, worker: false });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("is ready only while the worker heartbeat is younger than 30 s (TEST_PLAN §8)", async () => {
  vi.stubEnv("DATABASE_URL", url);
  expect((await readiness()).status).toBe(503); // no heartbeat yet
  await beatWorker(handle.db, { workerId: "w-ready", qlooReady: true });
  const ready = await readiness();
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ db: true, worker: true });
  // A paused (SIGSTOP) worker stops beating: 35 s later readiness fails.
  await handle.db.execute(
    sql`UPDATE worker_heartbeats SET last_beat_at = now() - interval '35 seconds'`,
  );
  const stale = await readiness();
  expect(stale.status).toBe(503);
  expect(await stale.json()).toEqual({ db: true, worker: false });
});

it("returns a generic 503 for an unreachable database", async () => {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://sentinel:private-value@127.0.0.1:1/unavailable",
  );
  const response = await readiness();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"db":false,"worker":false}');
});
