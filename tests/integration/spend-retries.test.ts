import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LLM_SPEND_METRIC,
  QUEUES,
  getRun,
  getUsage,
  sql,
  startExploration,
  utcDay,
  type DbHandle,
  type JobWithMetadata,
  type LlmSpendLimits,
  type PgBoss,
  type RunStepJob,
} from "../../packages/db/src";
import {
  LlmGateway,
  ProviderError,
  ScriptedLlmProvider,
} from "../../packages/llm-gateway/src";
import {
  createDbLlmRecorder,
  createSpendGuard,
} from "../../apps/worker/src/llm";
import { runStep } from "../../apps/worker/src/orchestrator/runner";
import {
  FixtureLibrary,
  RUN_CONFIG,
  makeDeps,
  seedProject,
  standardFixtures,
  startBoss,
} from "./helpers/exploration";
import { createTestDatabase } from "./helpers/test-db";

/**
 * Production shape of the paid path (ADR-018 + M10-A): Claude Sonnet with the same-model gateway
 * fallback, the DB spend guard, and pg-boss step retries. A provider outage must make every real
 * attempt reserve first against one global cap; once the cap is reached no further attempt
 * reaches the provider. Scripted provider only: no network, no paid call.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let lib: FixtureLibrary;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  lib = await FixtureLibrary.create();
  await standardFixtures(lib);
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
  await handle.db.execute(
    sql`DELETE FROM usage_counters WHERE metric = ${LLM_SPEND_METRIC}`,
  );
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
  await lib?.remove();
});

const MODEL = "claude-sonnet-5-5";
const outage = () =>
  new ScriptedLlmProvider().on(
    "r1.intent",
    ...Array.from({ length: 20 }, () => ({
      error: new ProviderError("unavailable", "LLM unavailable (529)", true),
    })),
  );

async function startRun() {
  const ids = await seedProject(handle);
  return startExploration(handle, boss, {
    workspaceId: ids.workspace.id,
    projectId: ids.project.id,
    briefVersionId: ids.brief.id,
    mode: "fixture",
    runConfig: RUN_CONFIG,
  });
}

/** Run the queued step and replay it as pg-boss redelivery does (retryLimit 2). */
async function runWithQueueRetries(
  provider: ScriptedLlmProvider,
  limits: LlmSpendLimits,
  models: { primary: string; fallback: string } = {
    primary: MODEL,
    fallback: MODEL,
  },
) {
  const gateway = new LlmGateway({
    provider,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    recorder: createDbLlmRecorder(handle.db),
    spendGuard: createSpendGuard(handle, limits),
  });
  const deps = makeDeps(handle, boss, lib, provider);
  const run = { ...deps, ports: { ...deps.ports, llm: gateway } };
  // Process jobs like the worker; replay a job that asks for a retry, as pg-boss redelivery does.
  let executions = 0;
  for (let jobs = 0; jobs < 10; jobs++) {
    const [job] = (await boss.fetch<RunStepJob>(QUEUES.runStep, {
      includeMetadata: true,
    })) as JobWithMetadata<RunStepJob>[];
    if (!job) break;
    for (let retryCount = 0; retryCount <= 2; retryCount++) {
      executions++;
      try {
        await runStep(run, job.data, { retryCount, retryLimit: 2 });
        break; // committed: no retry requested
      } catch {
        // RetryStep: pg-boss would redeliver this job.
      }
    }
    await boss.complete(QUEUES.runStep, job.id);
  }
  return executions;
}

async function ledger(runId: string) {
  const rows = (
    await handle.db.execute<{ status: string; reserved: string }>(
      sql`SELECT status, reserved_micros AS reserved FROM llm_spend_reservations WHERE run_id = ${runId}`,
    )
  ).rows;
  const invocations = Number(
    (
      await handle.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM llm_invocations WHERE run_id = ${runId}`,
      )
    ).rows[0]!.n,
  );
  const global = await getUsage(handle.db, {
    scope: "global",
    scopeId: "all",
    metric: LLM_SPEND_METRIC,
    day: utcDay(),
  });
  return { rows, invocations, global };
}

const limits = (globalUsd: number): LlmSpendLimits => ({
  access: "open",
  globalDailyUsd: globalUsd,
  workspaceDailyUsd: globalUsd,
  experimentUsd: globalUsd,
});

describe("gateway fallback and queue retries share one global budget", () => {
  it.each([
    // Production: LLM_MODEL = LLM_FALLBACK_MODEL = Sonnet, so the gateway does not switch.
    ["same-model fallback (production)", MODEL, 1, 0.5],
    // A distinct fallback model adds one gateway attempt per step execution. Opus attempts
    // reserve more, so this case gets room for all six; the next test covers the cap.
    ["distinct fallback model", "claude-opus-5-5", 2, 1],
  ] as const)(
    "%s: every real attempt reserves first and unknown outcomes stay charged",
    async (_, primary, perExecution, capUsd) => {
      const { runId } = await startRun();
      const provider = outage();
      await runWithQueueRetries(provider, limits(capUsd), {
        primary,
        fallback: MODEL,
      });
      const { rows, invocations, global } = await ledger(runId);

      // The intent step runs three times (first try + two queue retries).
      const attempts = 3 * perExecution;
      expect(provider.requests).toHaveLength(attempts);
      expect(rows).toHaveLength(attempts); // one reservation per real attempt
      expect(invocations).toBe(attempts); // failed attempts are recorded, never dropped
      // The provider may have billed a request it did not answer: the full reservation stays.
      expect(rows.every((r) => r.status === "UNKNOWN")).toBe(true);
      const reserved = rows.reduce((n, r) => n + Number(r.reserved), 0);
      expect(global).toBe(reserved);
      expect(global).toBeLessThanOrEqual(capUsd * 1_000_000);
      const run = await getRun(handle.db, runId);
      expect(run.state).toBe("FAILED");
    },
  );

  it("stops before the provider once the global $0.50-style cap is reached", async () => {
    // Measure one attempt's reservation, then allow room for only two.
    const probe = await startRun();
    await runWithQueueRetries(outage(), limits(0.5));
    const one = Number((await ledger(probe.runId)).rows[0]!.reserved);
    await boss.deleteQueuedJobs(QUEUES.runStep);
    await handle.db.execute(
      sql`DELETE FROM usage_counters WHERE metric = ${LLM_SPEND_METRIC}`,
    );

    const { runId } = await startRun();
    const provider = outage();
    const cap = (one * 2.5) / 1_000_000;
    await runWithQueueRetries(provider, limits(cap));
    const { rows, invocations, global } = await ledger(runId);

    expect(rows).toHaveLength(2); // the third reservation is refused
    expect(provider.requests).toHaveLength(2); // and never reaches the provider
    expect(invocations).toBe(2);
    expect(global).toBeLessThanOrEqual(cap * 1_000_000);
    const run = await getRun(handle.db, runId);
    expect(["FAILED", "COMPLETED_WITH_LIMITS"]).toContain(run.state);
  });
});
