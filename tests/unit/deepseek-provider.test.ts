import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DeepSeekProvider,
  LlmGateway,
  deepseekUsdPrices,
  deepseekReservationMicros,
} from "../../packages/llm-gateway/src";
import {
  createLlmGateway,
  effectiveModels,
  spendLimitsForProvider,
} from "../../apps/worker/src/llm";
import { parseWorkerEnv, parseWebEnv } from "../../packages/config/env";
import type { ProviderRequest } from "../../packages/llm-gateway/src";
const now = Date.parse("2026-10-23T10:00:00Z");
const approval = { usdPerCny: 0.2, verifiedAt: new Date(now).toISOString() }; // Synthetic FX, never a live quote.
const model = "deepseek-v4-pro";
const req: ProviderRequest = {
  promptId: "r1.intent",
  model,
  system: "Return JSON",
  messages: [{ role: "user", content: "Invented library cafe" }],
  jsonSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
  effort: "low",
  maxOutputTokens: 8192,
};
const payload = (override = {}) => ({
  model,
  status: "completed",
  output: [
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "private reasoning" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: '{"answer":"ok"}' }],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 30,
    total_tokens: 130,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 10 },
  },
  ...override,
});
function setup(
  overrides: Partial<ConstructorParameters<typeof DeepSeekProvider>[0]> = {},
  body = payload(),
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(body)));
  const provider = new DeepSeekProvider({
    apiKey: "deepseek-test-sentinel",
    liveApproved: true,
    priceApproval: approval,
    maxRequests: 4,
    budgetCny: 2,
    now: () => now,
    fetch: fetcher,
    ...overrides,
  });
  return { provider, fetcher };
}
const guard = () => ({
  reserve: vi.fn(async () => ({ ok: true as const, reservationId: "r" })),
  settle: vi.fn(async () => {}),
});
const input = {
  role: "R1" as const,
  promptId: "r1.intent",
  input: { brief: "Invented library cafe" },
  schema: z.strictObject({ answer: z.string().min(1) }),
  effort: "low" as const,
  maxOutputTokens: 8192,
  ctx: { projectId: "p", runId: "r", inputOrigin: "synthetic" as const },
};
function gateway(provider: DeepSeekProvider, spendGuard = guard()) {
  return new LlmGateway({
    provider,
    primaryModel: model,
    prices: deepseekUsdPrices(approval, now),
    spendGuard,
    fallbackModel: "deepseek-flash",
    maxRepairs: 3,
  });
}
describe("DeepSeek offline REST contract", () => {
  it.each(["deepseek-v4-pro", "deepseek-flash"])(
    "uses official schema Responses API for %s without disclosing reasoning",
    async (model) => {
      const { provider, fetcher } = setup({}, payload({ model }));
      const result = await provider.generate({ ...req, model });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.deepseek.com/responses");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer deepseek-test-sentinel" },
      });
      expect(JSON.parse(init!.body as string)).toMatchObject({
        text: { format: { type: "json_schema", schema: req.jsonSchema } },
        max_output_tokens: 8192,
        reasoning: { effort: "low" },
        stream: false,
      });
      expect(result).toMatchObject({
        text: '{"answer":"ok"}',
        usage: {
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningTokens: 10,
        },
      });
      expect(JSON.stringify(result)).not.toContain("private reasoning");
    },
  );
  it.each([
    { liveApproved: false },
    { maxRequests: 5 },
    { budgetCny: 2.01 },
    { priceApproval: { ...approval, usdPerCny: NaN } },
    { priceApproval: { ...approval, verifiedAt: "2026-10-21T00:00:00Z" } },
  ])("rejects unsafe configuration %o", (options) =>
    expect(() => setup(options)).toThrow(),
  );
  it.each([401, 402, 403, 404, 429, 500, 503])(
    "redacts HTTP %s and latches without retries",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("deepseek-test-sentinel private body", { status }),
        );
      const { provider } = setup({ fetch: fetcher });
      await expect(provider.generate(req)).rejects.toMatchObject({
        retryable: false,
        requestSent: true,
        status,
      });
      await expect(provider.generate(req)).rejects.toMatchObject({
        requestSent: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("reserves CNY and counts concurrent dispatches before awaiting", async () => {
    const { provider, fetcher } = setup({ maxRequests: 1 });
    const results = await Promise.allSettled([
      provider.generate(req),
      provider.generate(req),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const limited = setup({ budgetCny: 0.01 });
    await expect(limited.provider.generate(req)).rejects.toMatchObject({
      requestSent: false,
    });
    expect(limited.fetcher).not.toHaveBeenCalled();
    expect(deepseekReservationMicros(model, 16384, 8192)).toBe(405504);
  });
  it("rejects oversized, aborted, expired and unapproved calls without dispatch", async () => {
    let clock = now;
    const { provider, fetcher } = setup({ now: () => clock });
    for (const r of [
      { ...req, model: "unknown" },
      { ...req, maxOutputTokens: 8193 },
      { ...req, signal: AbortSignal.abort() },
      { ...req, system: "x".repeat(16384) },
    ])
      await expect(provider.generate(r)).rejects.toMatchObject({
        requestSent: false,
      });
    clock += 86400001;
    await expect(provider.generate(req)).rejects.toMatchObject({
      requestSent: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { usage: undefined },
    { model: "unapproved" },
    {
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        total_tokens: 1,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  ])("rejects incomplete usage or unexpected model %o", async (override) => {
    await expect(
      setup({}, payload(override)).provider.generate(req),
    ).rejects.toMatchObject({ kind: "unknown", retryable: false });
  });
  it("aborts hung requests and latches off without exposing errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(new Error("deepseek-test-sentinel")),
            ),
          ),
      );
    const { provider } = setup({ fetch: fetcher, timeoutMs: 10 });
    await expect(provider.generate(req)).rejects.toMatchObject({
      kind: "timeout",
      retryable: false,
    });
    await expect(provider.generate(req)).rejects.toMatchObject({
      requestSent: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe("DeepSeek gateway and worker protections", () => {
  it("converts peak CNY accounting once, including cache and reasoning, and settles USD", async () => {
    const { provider } = setup();
    const spend = guard();
    const result = await gateway(provider, spend).generate(input);
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      usageComplete: true,
      usage: { outputTokens: 30, reasoningTokens: 10 },
    });
    expect(result.costUsd).toBeCloseTo(
      ((80 * 9 + 20 * 0.3 + 30 * 27) / 1e6) * 0.2,
      10,
    );
    expect(spend.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ upperBoundUsd: 0.0811008 }),
    );
    expect(spend.settle).toHaveBeenCalledWith("r", result.costUsd);
  });
  it("denies Qloo or unknown provenance, missing guard, and denied grants before fetch", async () => {
    const { provider, fetcher } = setup();
    expect(
      await gateway(provider).generate({
        ...input,
        ctx: { ...input.ctx, inputOrigin: "unknown" },
      }),
    ).toMatchObject({ ok: false, reason: "CONFIGURATION" });
    expect(
      await new LlmGateway({
        provider,
        primaryModel: model,
        prices: deepseekUsdPrices(approval, now),
      }).generate(input),
    ).toMatchObject({ ok: false, reason: "CONFIGURATION" });
    const denied = new LlmGateway({
      provider,
      primaryModel: model,
      prices: deepseekUsdPrices(approval, now),
      spendGuard: {
        reserve: async () => ({
          ok: false,
          code: "RUN_ACCESS_REQUIRED",
          message: "Denied",
        }),
        settle: async () => {},
      },
    });
    expect(await denied.generate(input)).toMatchObject({
      ok: false,
      reason: "BUDGET",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    payload({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"answer":42}' }],
        },
      ],
    }),
    payload({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }),
    payload({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    }),
  ])("never repairs, retries truncation, or falls back", async (body) => {
    const { provider, fetcher } = setup({}, body);
    expect(await gateway(provider).generate(input)).toMatchObject({
      ok: false,
      attempts: 1,
      fallbackUsed: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains UNKNOWN reservation for missing usage", async () => {
    const { provider } = setup({}, payload({ usage: undefined }));
    const spend = guard();
    expect(await gateway(provider, spend).generate(input)).toMatchObject({
      ok: false,
      usageComplete: false,
    });
    expect(spend.settle).toHaveBeenCalledWith("r", null);
  });
  it("keeps live activation off and models explicit", () => {
    const base = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://local:placeholder@localhost/test",
      LLM_PROVIDER: "deepseek",
    };
    const settings = parseWorkerEnv(base);
    expect(settings).toMatchObject({
      DEEPSEEK_LIVE_APPROVED: "off",
      DEEPSEEK_BUDGET_CNY: 0,
      DEEPSEEK_MAX_REQUESTS: 0,
    });
    expect(createLlmGateway(settings, { record: async () => "r" })).toBeNull();
    expect(effectiveModels(settings)).toEqual({
      primary: model,
      fallback: model,
    });
    expect(effectiveModels({ ...settings, LLM_MODE: "economy" })).toEqual({
      primary: "deepseek-flash",
      fallback: "deepseek-flash",
    });
    expect(() =>
      parseWebEnv({ ...base, DEEPSEEK_API_KEY: "sentinel" }),
    ).toThrow("DEEPSEEK_API_KEY");
  });
  it.each([0, NaN, Infinity, -1, 1.01])(
    "rejects uncertain currency rate %s",
    (usdPerCny) =>
      expect(() =>
        deepseekUsdPrices({ ...approval, usdPerCny }, now),
      ).toThrow(),
  );
});

it("rejects unknown nested fields instead of silently stripping them", async () => {
  const { provider } = setup(
    {},
    payload({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: '{"nested":{"answer":"ok","invented":true}}',
            },
          ],
        },
      ],
    }),
  );
  const result = await gateway(provider).generate({
    ...input,
    schema: z.object({ nested: z.object({ answer: z.string() }) }),
  });
  expect(result).toMatchObject({
    ok: false,
    reason: "INVALID_OUTPUT",
    attempts: 1,
  });
});
it("worker factory activates only with synthetic mode and current explicit approvals", () => {
  const settings = parseWorkerEnv({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://local:placeholder@localhost/test",
    LLM_PROVIDER: "deepseek",
    QLOO_MODE: "synthetic",
    DEEPSEEK_API_KEY: "offline-only-sentinel",
    DEEPSEEK_LIVE_APPROVED: "on",
    DEEPSEEK_MAX_REQUESTS: "4",
    DEEPSEEK_BUDGET_CNY: "2",
    DEEPSEEK_USD_PER_CNY: "0.2",
    DEEPSEEK_PRICING_VERIFIED_AT: new Date().toISOString(),
  });
  const recorder = { record: async () => "offline" };
  expect(createLlmGateway(settings, recorder)?.providerName).toBe("deepseek");
  expect(
    createLlmGateway({ ...settings, QLOO_MODE: "live" }, recorder),
  ).toBeNull();
  expect(
    createLlmGateway(
      { ...settings, DEEPSEEK_PRICING_VERIFIED_AT: "2026-10-21T00:00:00Z" },
      recorder,
    ),
  ).toBeNull();
});

it("clamps persistent USD scopes to the native allowance and requires a grant even in open mode", () => {
  const settings = parseWorkerEnv({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://local:placeholder@localhost/test",
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_LIVE_APPROVED: "on",
    DEEPSEEK_BUDGET_CNY: "2",
    DEEPSEEK_USD_PER_CNY: "0.2",
    DEEPSEEK_PRICING_VERIFIED_AT: new Date().toISOString(),
  });
  const limits = {
    access: "open" as const,
    globalDailyUsd: 15,
    workspaceDailyUsd: 3,
    experimentUsd: 5,
  };
  expect(spendLimitsForProvider(settings, limits)).toEqual({
    access: "invite",
    globalDailyUsd: 0.4,
    workspaceDailyUsd: 0.4,
    experimentUsd: 0.4,
  });
  expect(
    spendLimitsForProvider(
      { ...settings, DEEPSEEK_USD_PER_CNY: undefined },
      limits,
    ),
  ).toMatchObject({ access: "off", globalDailyUsd: 0 });
  expect(
    spendLimitsForProvider(settings, {
      ...limits,
      access: "off",
      globalDailyUsd: 0,
    }),
  ).toMatchObject({ access: "off", globalDailyUsd: 0 });
});
