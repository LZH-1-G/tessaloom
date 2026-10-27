import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildRunConfig } from "../../apps/worker/src/compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
  createSpendGuard,
  type LlmSettings,
} from "../../apps/worker/src/llm";
import { createScriptedDemoProvider } from "../../apps/worker/src/scripted-llm";
import {
  LLM_SPEND_METRIC,
  QUEUES,
  blueprintView,
  createCounterfactualBranch,
  findComparison,
  getUsage,
  sql,
  startComposition,
  type DbHandle,
  type LlmSpendLimits,
  type PgBoss,
} from "../../packages/db/src";
import {
  GEMINI_PRICE_SCHEDULE,
  PromptRegistry,
  geminiPrices,
} from "../../packages/llm-gateway/src";
import { startBoss } from "./helpers/exploration";
import { syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/**
 * The complete Tessaloom workflow on the paid Gemini configuration: synthetic Qloo transport,
 * mocked Gemini HTTP (no key, no network), the real worker wiring and the PostgreSQL spend
 * ledger. The mock answers each prompt with the deterministic scripted outputs, wrapped in
 * the generateContent envelope, so every role (R1, R3, R4, R5, R6) crosses the Gemini adapter.
 */
const MODEL = "gemini-3.8-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const OPEN: LlmSpendLimits = {
  access: "open",
  globalDailyUsd: 1000,
  workspaceDailyUsd: 1000,
  experimentUsd: 1000,
};
const BRIEF = {
  title: "Harbor Lights supper club",
  challenge:
    "A 40-seat supper club wants a monthly night that pulls game, book and film fans together.",
  interests: [
    { text: "Stardew Harvest Tales", domainHint: "videogame" },
    { text: "Paper Atlas Stories", domainHint: "book" },
    { text: "Neon Harbor Nights", domainHint: "movie" },
  ],
  venue: { type: "cafe", capacity: 40 },
  constraints: { budgetBand: "low", durationMinutes: 120 },
  goals: ["Attract new weekday visitors"],
};

const prompts = new PromptRegistry();
const scripted = createScriptedDemoProvider();
const calls: { url: string; promptId: string }[] = [];

/** A stand-in for Google's endpoint. Anything else reaching `fetch` fails the test. */
const fakeGemini: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url !== ENDPOINT || init?.method !== "POST")
    throw new Error(`Unexpected network request: ${url}`);
  const body = JSON.parse(init.body as string) as {
    systemInstruction: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: {
      maxOutputTokens: number;
      responseMimeType: string;
      responseJsonSchema: Record<string, unknown>;
    };
  };
  expect(body.generationConfig.responseMimeType).toBe("application/json");
  expect(body.generationConfig.responseJsonSchema).toMatchObject({
    type: "object",
  });
  const first = body.contents[0]!.parts[0]!.text;
  const prompt = prompts.all().find((p) => first.startsWith(p.task));
  if (!prompt) throw new Error("Unknown prompt");
  calls.push({ url, promptId: prompt.id });
  const reply = await scripted.generate({
    promptId: prompt.id,
    model: MODEL,
    system: body.systemInstruction.parts[0]!.text,
    messages: body.contents.map((c) => ({
      role: c.role === "model" ? "assistant" : "user",
      content: c.parts[0]!.text,
    })),
    jsonSchema: body.generationConfig.responseJsonSchema,
    effort: "low",
    maxOutputTokens: body.generationConfig.maxOutputTokens,
  });
  const promptTokens = Math.ceil((init.body as string).length / 4);
  const candidates = Math.ceil(reply.text.length / 4);
  return new Response(
    JSON.stringify({
      modelVersion: MODEL,
      responseId: `mock-${calls.length}`,
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: reply.text }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: promptTokens,
        cachedContentTokenCount: 0,
        candidatesTokenCount: candidates,
        thoughtsTokenCount: 3,
        totalTokenCount: promptTokens + candidates + 3,
        serviceTier: "standard",
      },
    }),
  );
};

const paidSettings = (liveData: "off" | "on"): LlmSettings => ({
  LLM_PROVIDER: "gemini",
  APP_ENV: "test",
  LLM_MODEL: MODEL,
  LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
  LLM_MODE: "standard",
  QLOO_MODE: "synthetic",
  GEMINI_API_KEY: "test-private-sentinel",
  GEMINI_PAID_TIER_APPROVED: "on",
  GEMINI_PRICING_VERIFIED_AT: new Date().toISOString(),
  GEMINI_LIVE_DATA_APPROVED: liveData,
  GEMINI_MAX_REQUESTS: 500,
  GEMINI_TIMEOUT_MS: 5_000,
});
const RUN_CONFIG = buildRunConfig({
  llmModel: MODEL,
  llmFallbackModel: MODEL,
  promptVersions: prompts.versions(),
  harnessVersion: "synthetic",
});

let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
const harnessFor = (liveData: "off" | "on") =>
  syntheticHarness(handle, boss, {
    runConfig: RUN_CONFIG,
    llm: () =>
      createLlmGateway(
        paidSettings(liveData),
        createDbLlmRecorder(handle.db),
        undefined,
        createSpendGuard(handle, OPEN),
      ),
  });

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  vi.stubGlobal("fetch", vi.fn(fakeGemini));
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
  calls.length = 0;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await boss?.stop({ graceful: false });
  await drop?.();
});

async function invocations(runId: string) {
  return (
    await handle.db.execute<{
      provider: string;
      model_id: string;
      prompt_id: string;
      validation_status: string;
      input_tokens: number;
      output_tokens: number;
      input_excerpt: Record<string, unknown>;
    }>(
      sql`SELECT provider, model_id, prompt_id, validation_status, input_tokens, output_tokens, input_excerpt
          FROM llm_invocations WHERE run_id = ${runId} ORDER BY created_at, id`,
    )
  ).rows;
}
async function ledger(runId: string) {
  return (
    await handle.db.execute<{
      model: string;
      status: string;
      reserved_micros: string;
      actual_micros: string | null;
    }>(
      sql`SELECT model, status, reserved_micros, actual_micros
          FROM llm_spend_reservations WHERE run_id = ${runId} ORDER BY created_at, id`,
    )
  ).rows;
}
/** Each reservation was settled to a positive actual cost no larger than its upper bound. */
async function expectSettledPaidCalls(runId: string, count: number) {
  const rows = await ledger(runId);
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row).toMatchObject({ model: MODEL, status: "SETTLED" });
    expect(Number(row.actual_micros)).toBeGreaterThan(0);
    expect(Number(row.actual_micros)).toBeLessThanOrEqual(
      Number(row.reserved_micros),
    );
  }
  const spent = rows.reduce((n, r) => n + Number(r.actual_micros), 0);
  expect(
    await getUsage(handle.db, {
      scope: "run",
      scopeId: runId,
      metric: LLM_SPEND_METRIC,
      day: "total",
    }),
  ).toBe(spent);
  return spent;
}

describe("complete workflow on paid Gemini (synthetic Qloo, mocked Gemini HTTP)", () => {
  it("explores, selects, branches and composes a blueprint with every paid call reserved and settled", async () => {
    const harness = harnessFor("off");
    const ids = await harness.start(BRIEF, 0.6);
    const run = await harness.driveToEnd(harness.deps("off"), ids, {
      tension: 0.6,
      select: true,
    });
    expect(run.state).toBe("COMPLETED");

    // R1 intent, R3 generation, R4 critique (and any revision) all crossed the adapter.
    const explored = await invocations(ids.runId);
    expect(new Set(explored.map((r) => r.prompt_id))).toEqual(
      new Set(calls.map((c) => c.promptId)),
    );
    for (const id of ["r1.intent", "r3.generate", "r4.critique"])
      expect(explored.map((r) => r.prompt_id)).toContain(id);
    for (const row of explored) {
      expect(row).toMatchObject({ provider: "gemini", model_id: MODEL });
      expect(["VALID", "REPAIRED"]).toContain(row.validation_status);
      expect(row.input_tokens).toBeGreaterThan(0);
      expect(row.output_tokens).toBeGreaterThan(0);
      expect(row.input_excerpt).toMatchObject({
        billingTier: "paid",
        serviceTier: "standard",
        reasoningTokens: 3,
      });
    }
    const spent = await expectSettledPaidCalls(ids.runId, explored.length);
    // Ledger micro-USD = recorded tokens × published per-1M rates (nothing cached here),
    // within one micro of rounding per call.
    const rate = geminiPrices()[MODEL]!;
    expect(GEMINI_PRICE_SCHEDULE[MODEL]!.map((e) => e.rate)).toContainEqual(
      rate,
    );
    const expected = explored.reduce(
      (n, r) => n + r.input_tokens * rate.input + r.output_tokens * rate.output,
      0,
    );
    expect(Math.abs(spent - expected)).toBeLessThanOrEqual(explored.length);

    // Blueprint (R6) from the selected hypothesis.
    const top = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM hypotheses WHERE experiment_id = ${ids.experimentId} AND NOT retired ORDER BY composite_score DESC NULLS LAST LIMIT 1`,
    );
    calls.length = 0;
    const composition = await startComposition(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      hypothesisIds: [top.rows[0]!.id],
      format: "event",
      runConfig: RUN_CONFIG,
    });
    const composed = await harness.driveToEnd(
      harness.deps("off"),
      { ...ids, runId: composition.runId },
      { tension: 0.6, select: false },
    );
    expect(composed.state).toBe("COMPLETED");
    expect(calls.map((c) => c.promptId)).toContain("r6.compose");
    await expectSettledPaidCalls(
      composition.runId,
      (await invocations(composition.runId)).length,
    );
    const view = await blueprintView(
      handle.db,
      ids.workspaceId,
      composition.blueprintId,
    );
    expect(view.current).toBeTruthy();

    // A What-if branch is not attested synthetic (cross-experiment context), so without
    // live-data approval its R5 narrative is refused before any reservation or request,
    // and the comparison falls back to the deterministic template.
    calls.length = 0;
    const branch = await createCounterfactualBranch(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      delta: {
        scoringWeights: { support: 0.6, novelty: 0.2, feasibility: 0.2 },
      },
      mode: "hold_hypotheses",
      runConfig: RUN_CONFIG,
    });
    const branched = await harness.driveToEnd(
      harness.deps("off"),
      {
        workspaceId: ids.workspaceId,
        experimentId: branch.branchExperimentId,
        runId: branch.runId!,
      },
      { tension: 0.6, select: false },
    );
    expect(branched.state).toBe("COMPLETED");
    expect(calls).toHaveLength(0);
    expect(await ledger(branch.runId!)).toHaveLength(0);
    const comparison = await findComparison(
      handle.db,
      ids.experimentId,
      branch.branchExperimentId,
    );
    expect(comparison!.narrative).toMatchObject({ provenance: "APP_DERIVED" });
  });

  it("uses Gemini for the What-if narrative only once live-data permission is approved", async () => {
    const harness = harnessFor("on");
    const ids = await harness.start(BRIEF, 0.6);
    expect(
      (
        await harness.driveToEnd(harness.deps("off"), ids, {
          tension: 0.6,
          select: false,
        })
      ).state,
    ).toBe("COMPLETED");
    calls.length = 0;
    const branch = await createCounterfactualBranch(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      delta: {
        scoringWeights: { support: 0.6, novelty: 0.2, feasibility: 0.2 },
      },
      mode: "hold_hypotheses",
      runConfig: RUN_CONFIG,
    });
    const branched = await harness.driveToEnd(
      harness.deps("off"),
      {
        workspaceId: ids.workspaceId,
        experimentId: branch.branchExperimentId,
        runId: branch.runId!,
      },
      { tension: 0.6, select: false },
    );
    expect(branched.state).toBe("COMPLETED");
    expect(calls.map((c) => c.promptId)).toEqual(["r5.compare"]);
    await expectSettledPaidCalls(branch.runId!, 1);
    const comparison = await findComparison(
      handle.db,
      ids.experimentId,
      branch.branchExperimentId,
    );
    expect(comparison!.narrative).toMatchObject({
      provenance: "MODEL_INTERPRETATION",
    });
  });

  it("keeps the kill switch and invite-only access ahead of every Gemini request", async () => {
    for (const access of ["off", "invite"] as const) {
      const harness = syntheticHarness(handle, boss, {
        runConfig: RUN_CONFIG,
        llm: () =>
          createLlmGateway(
            paidSettings("off"),
            createDbLlmRecorder(handle.db),
            undefined,
            createSpendGuard(handle, { ...OPEN, access }),
          ),
      });
      const ids = await harness.start(BRIEF, 0.6);
      const run = await harness.driveToEnd(harness.deps("off"), ids, {
        tension: 0.6,
        select: false,
      });
      expect(run.state).not.toBe("COMPLETED");
      expect(calls).toHaveLength(0);
      expect(await ledger(ids.runId)).toHaveLength(0);
    }
  });
});
