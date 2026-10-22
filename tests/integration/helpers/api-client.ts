import { getWorkspace } from "../../../apps/web/src/server/api";
import { RateLimiter } from "../../../apps/web/src/server/http";
import type { Services } from "../../../apps/web/src/server/services";
import {
  beatWorker,
  type DbHandle,
  type PgBoss,
} from "../../../packages/db/src";
import { RUN_CONFIG } from "./synthetic";

export const ORIGIN = "http://tessaloom.test";

/** Web services for in-process API handler calls, with a fresh synthetic worker heartbeat. */
export async function makeServices(
  handle: DbHandle,
  boss: PgBoss,
): Promise<Services> {
  await beatWorker(handle.db, {
    workerId: "test-worker",
    qlooReady: true,
    harnessVersion: "synthetic",
    transport: "synthetic",
    runConfig: RUN_CONFIG,
  });
  return {
    handle,
    boss: async () => boss,
    sessionSecret: "test-session-secret-at-least-32-bytes!",
    appEnv: "test",
    pepper: "test-pepper-value-at-least-32-bytes!!",
    secureCookies: false,
    limiter: new RateLimiter(),
    now: () => new Date(),
    heartbeatMaxAgeMs: 30_000,
    sse: { pollMs: 10, pingMs: 30, maxDurationMs: 5_000 },
    dailyRunsPerWorkspace: 50,
  };
}

/** A browser-like client: its own workspace cookie, CSRF header, and same-origin headers. */
export async function apiClient(s: Services) {
  const res = await getWorkspace(s, new Request(`${ORIGIN}/api/v1/workspace`));
  const workspace = (await res.json()) as { id: string };
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const csrf = cookies.find((c) => c.startsWith("tl_csrf="))!.slice(8);
  const headers = {
    cookie: cookies.join("; "),
    origin: ORIGIN,
    host: "tessaloom.test",
    "x-tessaloom-csrf": csrf,
    "content-type": "application/json",
  };
  const send = (method: string, path: string, body?: unknown, csrfOk = true) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: csrfOk
        ? headers
        : { ...headers, "x-tessaloom-csrf": "wrong-token" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    workspaceId: workspace.id,
    get: (path: string) => send("GET", path),
    post: (path: string, body: unknown, csrfOk = true) =>
      send("POST", path, body, csrfOk),
    put: (path: string, body: unknown, csrfOk = true) =>
      send("PUT", path, body, csrfOk),
  };
}

export const json = async <T>(res: Response) => (await res.json()) as T;
