import { parseWorkerEnv, runAccessFor } from "@tessaloom/config/env";
import {
  QUEUES,
  beatWorker,
  createBoss,
  createDb,
  databaseFailure,
  registerPromptTemplate,
  type JobWithMetadata,
  type RunStepJob,
} from "@tessaloom/db";
import { PromptRegistry } from "@tessaloom/llm-gateway";
import {
  checkQlooReadiness,
  type QlooReadiness,
} from "@tessaloom/qloo-adapter";
import { buildPorts, buildRunConfig, createQlooAdapter } from "./compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
  createSpendGuard,
  spendLimitsForProvider,
  effectiveModels,
} from "./llm";
import {
  expirePausedRuns,
  recoverStalledRuns,
} from "./orchestrator/maintenance";
import { runStep, type RunnerDeps } from "./orchestrator/runner";

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

// M4: the worker executes run steps from pg-boss, owns Qloo readiness and the heartbeat
// that `/api/health/ready` consumes, and publishes its run configuration with each beat.
const workerId = env.TL_HEARTBEAT_ID ?? `worker-${crypto.randomUUID()}`;
const handle = createDb(env.DATABASE_URL, {
  max: 5,
  applicationName: "tessaloom-worker",
});
const boss = createBoss(env.DATABASE_URL, { role: "worker" });
const prompts = new PromptRegistry();
let readiness: QlooReadiness | null = null;
let stopping = false;
let queuesStarted = false;
let lastHeartbeatError: string | null = null;
let startupStage = "queue_connect";
let startup: Promise<void> | undefined;

// Every provider attempt goes through the spend ledger (M10-A public demo cost safety).
const gateway = createLlmGateway(
  env,
  createDbLlmRecorder(handle.db),
  undefined,
  createSpendGuard(
    handle,
    spendLimitsForProvider(env, {
      access: runAccessFor(env.APP_ENV, env.RUN_ACCESS),
      globalDailyUsd: env.GLOBAL_DAILY_LLM_USD,
      workspaceDailyUsd: env.WORKSPACE_DAILY_LLM_USD,
      experimentUsd: env.EXPERIMENT_LLM_USD,
    }),
  ),
);
const harnessVersion = () =>
  env.QLOO_MODE === "fixture" || env.QLOO_MODE === "synthetic"
    ? env.QLOO_MODE
    : (readiness?.harnessVersion ?? null);
const runConfig = () =>
  buildRunConfig({
    llmModel: effectiveModels(env).primary,
    llmFallbackModel: effectiveModels(env).fallback,
    promptVersions: prompts.versions(),
    harnessVersion: harnessVersion(),
  });

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
  // Readiness means "can execute runs": beat only once the job consumer is running.
  if (!queuesStarted || stopping) return;
  try {
    await beatWorker(handle.db, {
      workerId,
      qlooReady:
        env.QLOO_MODE === "fixture" || env.QLOO_MODE === "synthetic"
          ? true
          : (readiness?.ready ?? false),
      harnessVersion: harnessVersion(),
      transport:
        env.QLOO_MODE === "live" ? "HARNESS_MCP" : (env.QLOO_MODE ?? null),
      runConfig: runConfig(),
    });
    if (lastHeartbeatError) log("worker_heartbeat_recovered");
    lastHeartbeatError = null;
  } catch (error) {
    // Database outages must not crash the worker; log each failure class once.
    const code = databaseFailure(error);
    if (lastHeartbeatError !== code) log("worker_heartbeat_failed", { code });
    lastHeartbeatError = code;
  }
}

async function startQueues() {
  if (stopping) return;
  startupStage = "queue_connect";
  await boss.start();
  if (stopping) return;
  const qloo = createQlooAdapter(handle.db, {
    mode: env.QLOO_MODE,
    appEnv: env.APP_ENV,
    harnessVersion: harnessVersion(),
    dailyLimit: env.GLOBAL_DAILY_QLOO_CALLS,
    rateLimitPerMin: env.QLOO_RATE_LIMIT_PER_MIN,
    rawRetention: env.QLOO_RAW_RETENTION,
  });
  const deps: RunnerDeps = {
    handle,
    boss,
    ports: buildPorts(qloo, gateway),
    log,
  };
  startupStage = "run_step_consumer";
  await boss.work(
    QUEUES.runStep,
    {
      includeMetadata: true,
      batchSize: 1,
      pollingIntervalSeconds: 1,
      localConcurrency: 2,
    },
    async ([job]: JobWithMetadata<RunStepJob>[]) => {
      if (!job) return;
      const outcome = await runStep(deps, job.data, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
      return { outcome: outcome.outcome };
    },
  );
  if (stopping) return;
  startupStage = "maintenance_consumers";
  await boss.work(QUEUES.expirePausedRuns, async () => {
    const expired = await expirePausedRuns(handle, new Date());
    if (expired) log("runs_expired", { count: expired });
  });
  await boss.work(QUEUES.recoverRuns, async () => {
    const recovered = await recoverStalledRuns(handle, boss, new Date());
    if (recovered) log("runs_recovered", { count: recovered });
  });
  if (stopping) return;
  startupStage = "maintenance_schedules";
  await boss.schedule(QUEUES.expirePausedRuns, "*/15 * * * *");
  await boss.schedule(QUEUES.recoverRuns, "*/5 * * * *");
  if (stopping) return;
  startupStage = "prompt_registry";
  for (const p of prompts.all())
    await registerPromptTemplate(handle.db, {
      promptId: p.id,
      version: p.version,
      contentHash: p.contentHash,
    });
  if (stopping) return;
  queuesStarted = true;
  log("worker_queues_started", {
    llm: gateway ? gateway.providerName : "unconfigured",
    qlooMode: env.QLOO_MODE ?? null,
  });
}

const heartbeatTimer = setInterval(() => void heartbeat(), 10_000);
const readinessTimer = setInterval(() => void refreshReadiness(), 5 * 60_000);

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  queuesStarted = false;
  clearInterval(heartbeatTimer);
  clearInterval(readinessTimer);
  clearTimeout(queueRetryTimer);
  // Serialize stop after an in-flight start: no late consumers or retries after shutdown.
  await startup;
  await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => {});
  await handle.close().catch(() => {});
  log("worker_stopped", { signal });
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));
log("worker_started", {
  milestone: "M4",
  pid: process.pid,
  qlooMode: env.QLOO_MODE ?? null,
});
let queueRetryTimer: NodeJS.Timeout | undefined;
async function startQueuesWithRetry() {
  if (stopping) return;
  try {
    await startQueues();
    await heartbeat();
  } catch (error) {
    // The queue schema comes from the release migrator, and the database may still be
    // starting: retry instead of crash-looping. No heartbeat is written meanwhile.
    queuesStarted = false;
    log("worker_queue_start_failed", {
      stage: startupStage,
      reason: databaseFailure(error),
      retryMs: 15_000,
    });
    await boss.stop({ graceful: false }).catch(() => {});
    if (!stopping)
      queueRetryTimer = setTimeout(() => {
        startup = startQueuesWithRetry();
      }, 15_000);
  }
}
// Local harness diagnostics are independent of queue readiness and never use --network.
void refreshReadiness();
startup = startQueuesWithRetry();
