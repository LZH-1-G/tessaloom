import { parseWebEnv, runAccessFor } from "@tessaloom/config/env";
import {
  createBoss,
  createDb,
  type DbHandle,
  type PgBoss,
  type RunAdmission,
} from "@tessaloom/db";
import { RateLimiter, secureCookiesFor } from "./http";

/** Everything an API handler needs; tests construct their own instance. */
export interface Services {
  handle: DbHandle;
  /** Lazily started pg-boss sender (the web process never runs maintenance). */
  boss: () => Promise<PgBoss>;
  sessionSecret: string;
  appEnv: string;
  pepper: string;
  secureCookies: boolean;
  limiter: RateLimiter;
  now: () => Date;
  /** Max worker heartbeat age for readiness and run starts (API_CONTRACTS §4.8). */
  heartbeatMaxAgeMs: number;
  /** SSE timings (tests shorten them). */
  sse: { pollMs: number; pingMs: number; maxDurationMs: number };
  dailyRunsPerWorkspace: number;
  /** M10-A: who may start paid work, and the job-creation limits (admitted in-transaction). */
  admission: RunAdmission;
  trustedProxyHops?: number;
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
    appEnv: env.APP_ENV,
    pepper: env.SHARE_TOKEN_PEPPER,
    secureCookies: secureCookiesFor(env.APP_ENV),
    limiter: new RateLimiter(),
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    now: () => new Date(),
    heartbeatMaxAgeMs: 30_000,
    sse: { pollMs: 1000, pingMs: 15_000, maxDurationMs: 10 * 60_000 },
    dailyRunsPerWorkspace: 10,
    admission: {
      access: runAccessFor(env.APP_ENV, env.RUN_ACCESS),
      maxActivePerWorkspace: env.MAX_ACTIVE_RUNS_PER_WORKSPACE,
      maxWorkingGlobal: env.MAX_WORKING_RUNS,
      dailyRunsPerWorkspace: env.WORKSPACE_DAILY_RUNS,
    },
  };
  return singleton;
}
