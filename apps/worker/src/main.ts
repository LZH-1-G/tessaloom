import { parseWorkerEnv } from "@tessaloom/config/env";
import { beatWorker, createDb } from "@tessaloom/db";
import {
  checkQlooReadiness,
  type QlooReadiness,
} from "@tessaloom/qloo-adapter";

let env: ReturnType<typeof parseWorkerEnv>;
try {
  env = parseWorkerEnv(process.env);
} catch (error) {
  console.error(
    JSON.stringify({
      event: "worker_config_invalid",
      message: (error as Error).message,
    }),
  );
  process.exit(1);
}

const log = (event: string, details: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...details }));

// M2: the worker owns Qloo readiness (local check, no network) and the heartbeat that
// `/api/health/ready` will consume in M4. Job execution arrives with M4.
const workerId = `worker-${process.pid}`;
const handle = createDb(env.DATABASE_URL, {
  max: 2,
  applicationName: "tessaloom-worker",
});
let readiness: QlooReadiness | null = null;
let stopping = false;
let lastHeartbeatError: string | null = null;

async function refreshReadiness() {
  if (env.QLOO_MODE !== "live" || !env.QLOO_BASE_URL) {
    readiness = null;
    return;
  }
  readiness = await checkQlooReadiness({ expectedBaseUrl: env.QLOO_BASE_URL });
  // State only: no messages, keys, or paths are logged.
  log("worker_qloo_readiness", {
    ready: readiness.ready,
    reason: readiness.reason ?? null,
    endpointTrusted: readiness.endpointTrusted,
    harnessVersion: readiness.harnessVersion,
  });
}

async function heartbeat() {
  try {
    await beatWorker(handle.db, {
      workerId,
      qlooReady: readiness?.ready ?? false,
      harnessVersion: readiness?.harnessVersion ?? null,
      transport:
        env.QLOO_MODE === "live" ? "HARNESS_MCP" : (env.QLOO_MODE ?? null),
    });
    if (lastHeartbeatError) log("worker_heartbeat_recovered");
    lastHeartbeatError = null;
  } catch (error) {
    // Database outages must not crash the worker; log each failure class once.
    const code =
      (error as { cause?: { code?: string }; code?: string }).cause?.code ??
      (error as { code?: string }).code ??
      "unknown";
    if (lastHeartbeatError !== code) log("worker_heartbeat_failed", { code });
    lastHeartbeatError = code;
  }
}

const heartbeatTimer = setInterval(() => void heartbeat(), 10_000);
const readinessTimer = setInterval(() => void refreshReadiness(), 5 * 60_000);

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeatTimer);
  clearInterval(readinessTimer);
  await handle.close().catch(() => {});
  log("worker_stopped", { signal });
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
log("worker_started", {
  milestone: "M2",
  pid: process.pid,
  qlooMode: env.QLOO_MODE ?? null,
});
void refreshReadiness().then(heartbeat);
