import { afterEach, expect, it, vi } from "vitest";
import { GET as liveness } from "../../apps/web/src/app/api/health/route";
import { GET as readiness } from "../../apps/web/src/app/api/health/ready/route";

afterEach(() => vi.unstubAllEnvs());

it("returns liveness without database access", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://invalid@127.0.0.1:1/unavailable");
  const response = liveness();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version: "0.0.0" });
});

it("checks a real PostgreSQL connection without requiring any schema", async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for integration tests");
  const response = await readiness();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ db: true });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("returns a generic 503 for an unreachable database", async () => {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://sentinel:private-value@127.0.0.1:1/unavailable",
  );
  const response = await readiness();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"db":false}');
});
