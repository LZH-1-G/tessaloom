import { parseWebEnv } from "@tessaloom/config/env";
import {
  createBoss,
  createDb,
  type DbHandle,
  type PgBoss,
} from "@tessaloom/db";
import { RateLimiter } from "./http";

/** Everything an API handler needs; tests construct their own instance. */
export interface Services {
  handle: DbHandle;
  /** Lazily started pg-boss sender (the web process never runs maintenance). */
  boss: () => Promise<PgBoss>;
  sessionSecret: string;
  pepper: string;
  secureCookies: boolean;
  limiter: RateLimiter;
  now: () => Date;
  /** Max worker heartbeat age for readiness and run starts (API_CONTRACTS §4.8). */
  heartbeatMaxAgeMs: number;
  /** SSE timings (tests shorten them). */
  sse: { pollMs: number; pingMs: number; maxDurationMs: number };
  dailyRunsPerWorkspace: number;
}

let singleton: Services | null = null;

export function services(): Services {
  if (singleton) return singleton;
  const env = parseWebEnv(process.env);
  const handle = createDb(env.DATABASE_URL, {
    max: 5,
    applicationName: "tessaloom-web",
  });
  let started: Promise<PgBoss> | null = null;
  singleton = {
    handle,
    boss: () =>
      (started ??= (async () => {
        const boss = createBoss(env.DATABASE_URL, { role: "web" });
        await boss.start();
        return boss;
      })().catch((error: unknown) => {
        started = null;
        throw error;
      })),
    sessionSecret: env.SESSION_SECRET,
    pepper: env.SHARE_TOKEN_PEPPER,
    secureCookies: env.NODE_ENV === "production",
    limiter: new RateLimiter(),
    now: () => new Date(),
    heartbeatMaxAgeMs: 30_000,
    sse: { pollMs: 1000, pingMs: 15_000, maxDurationMs: 10 * 60_000 },
    dailyRunsPerWorkspace: 10,
  };
  return singleton;
}
