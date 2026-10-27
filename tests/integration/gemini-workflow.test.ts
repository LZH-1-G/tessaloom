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
  getRun,
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
 * The complete Tessaloom workflow on the paid Gemini configuration, for each candidate
 * production model: synthetic Qloo transport, mocked Gemini HTTP (no key, no network), the
 * real worker wiring and the PostgreSQL spend ledger. The mock answers each prompt with the
 * deterministic scripted outputs in the generateContent envelope, so every role (R1, R3, R4,
 * R5, R6) crosses the Gemini adapter; faults are injected per prompt.
 */
const MODELS = ["gemini-4-argon", "gemini-3.8-flash"] as const;
type Model = (typeof MODELS)[number];
const ENDPOINT =
  /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([a-z0-9.-]+):generateContent$/;
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

type Fault = "invalid" | "max_tokens" | "hang" | "http503";
const prompts = new PromptRegistry();
const scripted = createScriptedDemoProvider();
const calls: {
  model: string;
  promptId: string;
  maxOutputTokens: number;
  thinkingLevel?: string;
}[] = [];
const faults = new Map<string, Fault[]>();

/** A stand-in for Google's endpoint. Anything else reaching `fetch` fails the test. */
const fakeGemini: typeof fetch = async (input, init) => {
  const url = String(input);
  const model = ENDPOINT.exec(url)?.[1];
  if (!model || init?.method !== "POST")
    throw new Error(`Unexpected network request: ${url}`);
  const body = JSON.parse(init.body as string) as {
    systemInstruction: { parts: { text: string }[] };
    contents: { role: string; parts: { text: string }[] }[];
    generationConfig: {
      maxOutputTokens: number;
      responseMimeType: string;
      responseJsonSchema: Record<string, unknown>;
      thinkingConfig?: { thinkingLevel?: string };
    };
  };
  expect(body.generationConfig.responseMimeType).toBe("application/json");
  expect(JSON.stringify(body.generationConfig)).not.toMatch(
    /candidateCount|thinkingBudget|temperature|"\$ref"|"\$defs"/,
  );
  const first = body.contents[0]!.parts[0]!.text;
  const prompt = prompts.all().find((p) => first.startsWith(p.task));
  if (!prompt) throw new Error("Unknown prompt");
  calls.push({
    model,
    promptId: prompt.id,
    maxOutputTokens: body.generationConfig.maxOutputTokens,
    thinkingLevel: body.generationConfig.thinkingConfig?.thinkingLevel,
  });
  const fault = faults.get(prompt.id)?.shift();
  if (fault === "http503") return new Response("overloaded", { status: 503 });
  if (fault === "hang")
    return new Promise((_resolve, reject) =>
      init.signal!.addEventListener("abort", () => reject(new Error("abort")), {
        once: true,
      }),
    );
  const reply = await scripted.generate({
    promptId: prompt.id,
    model,
    system: body.systemInstruction.parts[0]!.text,
    messages: body.contents.map((c) => ({
      role: c.role === "model" ? "assistant" : "user",
      content: c.parts[0]!.text,
    })),
    jsonSchema: body.generationConfig.responseJsonSchema,
    effort: "low",
    maxOutputTokens: body.generationConfig.maxOutputTokens,
  });
  const text = fault === "invalid" ? "{}" : reply.text;
  const promptTokens = Math.ceil((init.body as string).length / 4);
  const thoughts = 40;
  const candidates =
    fault === "max_tokens"
      ? body.generationConfig.maxOutputTokens - thoughts
      : Math.ceil(text.length / 4);
  return new Response(
    JSON.stringify({
      modelVersion: model,
      responseId: `mock-${calls.length}`,
      candidates: [
        {
          finishReason: fault === "max_tokens" ? "MAX_TOKENS" : "STOP",
          content: {
            role: "model",
            parts: [{ text: fault === "max_tokens" ? text.slice(0, 9) : text }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: promptTokens,
        cachedContentTokenCount: 0,
        candidatesTokenCount: candidates,
        thoughtsTokenCount: thoughts,
        totalTokenCount: promptTokens + candidates + thoughts,
        serviceTier: "standard",
      },
    }),
  );
};

const settingsFor = (
  model: Model,
  overrides: Partial<LlmSettings> = {},
): LlmSettings => ({
  LLM_PROVIDER: "gemini",
  APP_ENV: "test",
  LLM_MODEL: model,
  LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
  LLM_MODE: "standard",
  QLOO_MODE: "synthetic",
  GEMINI_API_KEY: "test-private-sentinel",
  GEMINI_PAID_TIER_APPROVED: "on",
  GEMINI_PRICING_VERIFIED_AT: new Date().toISOString(),
  GEMINI_LIVE_DATA_APPROVED: "off",
  GEMINI_MAX_REQUESTS: 500,
  GEMINI_TIMEOUT_MS: 5_000,
  ...overrides,
});
const runConfigFor = (model: Model) =>
  buildRunConfig({
    llmModel: model,
    llmFallbackModel: model,
    promptVersions: prompts.versions(),
    harnessVersion: "synthetic",
  });

let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
const harnessFor = (
  model: Model,
  overrides: Partial<LlmSettings> = {},
  limits: LlmSpendLimits = OPEN,
) =>
  syntheticHarness(handle, boss, {
    runConfig: runConfigFor(model),
    llm: () =>
      createLlmGateway(
        settingsFor(model, overrides),
        createDbLlmRecorder(handle.db),
        undefined,
        createSpendGuard(handle, limits),
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
  faults.clear();
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
      stop_reason: string | null;
      input_tokens: number;
      output_tokens: number;
      input_excerpt: Record<string, unknown>;
    }>(
      sql`SELECT provider, model_id, prompt_id, validation_status, stop_reason, input_tokens, output_tokens, input_excerpt
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
const runSpend = (runId: string) =>
  getUsage(handle.db, {
    scope: "run",
    scopeId: runId,
    metric: LLM_SPEND_METRIC,
    day: "total",
  });
/** Each reservation was settled to a positive actual cost no larger than its upper bound. */
async function expectSettledPaidCalls(
  runId: string,
  model: Model,
  count: number,
) {
  const rows = await ledger(runId);
  expect(rows).toHaveLength(count);
  for (const row of rows) {
    expect(row).toMatchObject({ model, status: "SETTLED" });
    expect(Number(row.actual_micros)).toBeGreaterThan(0);
    expect(Number(row.actual_micros)).toBeLessThanOrEqual(
      Number(row.reserved_micros),
    );
  }
  const spent = rows.reduce((n, r) => n + Number(r.actual_micros), 0);
  expect(await runSpend(runId)).toBe(spent);
  return spent;
}
const topHypothesis = async (experimentId: string) =>
  (
    await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM hypotheses WHERE experiment_id = ${experimentId} AND NOT retired ORDER BY composite_score DESC NULLS LAST LIMIT 1`,
    )
  ).rows[0]!.id;

describe.each(MODELS)(
  "complete workflow on paid %s (synthetic Qloo, mocked Gemini HTTP)",
  (model) => {
    it("brief → entities → discovery → bridges → hypotheses → evidence → blueprint → What-if, every call reserved and settled", async () => {
      const harness = harnessFor(model);
      const ids = await harness.start(BRIEF, 0.6);
      const run = await harness.driveToEnd(harness.deps("off"), ids, {
        tension: 0.6,
        select: true,
      });
      expect(run.state).toBe("COMPLETED");

      // R1 intent, R3 generation, R4 critique (and any revision) crossed the adapter.
      const explored = await invocations(ids.runId);
      expect(new Set(explored.map((r) => r.prompt_id))).toEqual(
        new Set(calls.map((c) => c.promptId)),
      );
      for (const id of ["r1.intent", "r3.generate", "r4.critique"])
        expect(explored.map((r) => r.prompt_id)).toContain(id);
      expect(new Set(calls.map((c) => c.model))).toEqual(new Set([model]));
      for (const row of explored) {
        expect(row).toMatchObject({ provider: "gemini", model_id: model });
        expect(["VALID", "REPAIRED"]).toContain(row.validation_status);
        expect(row.input_excerpt).toMatchObject({
          billingTier: "paid",
          serviceTier: "standard",
          thinkingLevel: "model-default",
          reasoningTokens: 40,
        });
      }
      const spent = await expectSettledPaidCalls(
        ids.runId,
        model,
        explored.length,
      );
      // Ledger micro-USD = recorded tokens × the model's rates in effect (thinking billed as
      // output; nothing cached here), within one micro of rounding per call.
      const rate = geminiPrices()[model]!;
      expect(GEMINI_PRICE_SCHEDULE[model]!.map((e) => e.rate)).toContainEqual(
        rate,
      );
      const expected = explored.reduce(
        (n, r) =>
          n + r.input_tokens * rate.input + r.output_tokens * rate.output,
        0,
      );
      expect(Math.abs(spent - expected)).toBeLessThanOrEqual(explored.length);

      // Blueprint (R6) from the selected hypothesis.
      calls.length = 0;
      const composition = await startComposition(handle, boss, {
        workspaceId: ids.workspaceId,
        experimentId: ids.experimentId,
        hypothesisIds: [await topHypothesis(ids.experimentId)],
        format: "event",
        runConfig: runConfigFor(model),
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
        model,
        (await invocations(composition.runId)).length,
      );
      const view = await blueprintView(
        handle.db,
        ids.workspaceId,
        composition.blueprintId,
      );
      expect(view.current).toBeTruthy();

      // What-if: a branch is not attested synthetic (cross-experiment context), so without
      // live-data approval R5 is refused before any reservation or request, and the
      // comparison falls back to the deterministic template.
      calls.length = 0;
      const branch = await createCounterfactualBranch(handle, boss, {
        workspaceId: ids.workspaceId,
        experimentId: ids.experimentId,
        delta: {
          scoringWeights: { support: 0.6, novelty: 0.2, feasibility: 0.2 },
        },
        mode: "hold_hypotheses",
        runConfig: runConfigFor(model),
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
      expect(
        (await findComparison(
          handle.db,
          ids.experimentId,
          branch.branchExperimentId,
        ))!.narrative,
      ).toMatchObject({ provenance: "APP_DERIVED" });
    });

    it("repairs a schema-invalid output once and retries a truncated one at 1.5×, each attempt reserved", async () => {
      faults.set("r1.intent", ["invalid"]);
      faults.set("r3.generate", ["max_tokens"]);
      const harness = harnessFor(model);
      const ids = await harness.start(BRIEF, 0.6);
      const run = await harness.driveToEnd(harness.deps("off"), ids, {
        tension: 0.6,
        select: false,
      });
      expect(run.state).toBe("COMPLETED");
      const rows = await invocations(ids.runId);
      const r1 = rows.filter((r) => r.prompt_id === "r1.intent");
      expect(r1.map((r) => r.validation_status)).toEqual([
        "INVALID",
        "REPAIRED",
      ]);
      const r3 = calls.filter((c) => c.promptId === "r3.generate");
      expect(r3.map((c) => c.maxOutputTokens)).toEqual([12_000, 18_000]);
      expect(
        rows.filter((r) => r.prompt_id === "r3.generate")[0],
      ).toMatchObject({
        validation_status: "TRUNCATED",
        stop_reason: "max_tokens",
      });
      // Every request, including repairs and truncation retries, was reserved first.
      await expectSettledPaidCalls(ids.runId, model, calls.length);
    });

    it("never retries a timed-out request (possibly billed) and keeps its reservation charged", async () => {
      faults.set("r1.intent", ["hang"]);
      const harness = harnessFor(model, { GEMINI_TIMEOUT_MS: 200 });
      const ids = await harness.start(BRIEF, 0.6);
      await harness.driveToEnd(harness.deps("off"), ids, {
        tension: 0.6,
        select: false,
      });
      const run = await getRun(handle.db, ids.runId);
      expect(run).toMatchObject({
        state: "FAILED",
        terminalReason: "LLM_UNAVAILABLE",
      });
      expect(calls).toHaveLength(1);
      const rows = await ledger(ids.runId);
      expect(rows.map((r) => r.status)).toEqual(["UNKNOWN"]);
      expect(await runSpend(ids.runId)).toBe(Number(rows[0]!.reserved_micros));
    });

    it("marks a provider 503 (not billed) for a delayed step retry instead of failing the run", async () => {
      faults.set("r1.intent", ["http503"]);
      const harness = harnessFor(model);
      const ids = await harness.start(BRIEF, 0.6);
      await expect(
        harness.driveToEnd(harness.deps("off"), ids, {
          tension: 0.6,
          select: false,
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect((await getRun(handle.db, ids.runId)).state).not.toBe("FAILED");
    });
  },
);

describe("paid Gemini 4 Argon controls", () => {
  it("sends an explicitly configured thinking level, and nothing else changes", async () => {
    const harness = harnessFor("gemini-4-argon", {
      GEMINI_THINKING_LEVEL: "low",
    });
    const ids = await harness.start(BRIEF, 0.6);
    const run = await harness.driveToEnd(harness.deps("off"), ids, {
      tension: 0.6,
      select: false,
    });
    expect(run.state).toBe("COMPLETED");
    expect(new Set(calls.map((c) => c.thinkingLevel))).toEqual(
      new Set(["low"]),
    );
    expect((await invocations(ids.runId))[0]!.input_excerpt).toMatchObject({
      thinkingLevel: "low",
    });
  });

  it("stops at the experiment cap: never spends or sends beyond a reservation", async () => {
    // Below one Argon R3 reservation (12k output tokens at $10–20 per 1M): R3 is refused.
    const cap = 0.1;
    const harness = harnessFor(
      "gemini-4-argon",
      {},
      {
        ...OPEN,
        experimentUsd: cap,
      },
    );
    const ids = await harness.start(BRIEF, 0.6);
    const run = await harness.driveToEnd(harness.deps("off"), ids, {
      tension: 0.6,
      select: false,
    });
    expect(run.state).not.toBe("COMPLETED");
    expect((await getRun(handle.db, ids.runId)).terminalReason).toMatch(
      /^BUDGET/,
    );
    expect(calls.map((c) => c.promptId)).not.toContain("r3.generate");
    const rows = await ledger(ids.runId);
    // Every request had a reservation; settled spend never exceeds the cap.
    expect(calls).toHaveLength(rows.length);
    expect(await runSpend(ids.runId)).toBeLessThanOrEqual(cap * 1_000_000);
  });

  it("uses Gemini for the What-if narrative only once live-data permission is approved", async () => {
    const harness = harnessFor("gemini-4-argon", {
      GEMINI_LIVE_DATA_APPROVED: "on",
    });
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
      runConfig: runConfigFor("gemini-4-argon"),
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
    await expectSettledPaidCalls(branch.runId!, "gemini-4-argon", 1);
    expect(
      (await findComparison(
        handle.db,
        ids.experimentId,
        branch.branchExperimentId,
      ))!.narrative,
    ).toMatchObject({ provenance: "MODEL_INTERPRETATION" });
  });

  it("keeps the kill switch and invite-only access ahead of every Gemini request", async () => {
    for (const access of ["off", "invite"] as const) {
      const harness = harnessFor("gemini-4-argon", {}, { ...OPEN, access });
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

  it("is never configured on the free tier: Argon is paid-only", () => {
    expect(
      createLlmGateway(
        settingsFor("gemini-4-argon", {
          GEMINI_PAID_TIER_APPROVED: "off",
          GEMINI_FREE_TIER_CONFIRMED: "on",
          GEMINI_DATA_SHARING_APPROVED: "on",
          GEMINI_MAX_REQUESTS: 10,
        }),
        createDbLlmRecorder(handle.db),
        undefined,
        createSpendGuard(handle, OPEN),
      ),
    ).toBeNull();
  });
});
