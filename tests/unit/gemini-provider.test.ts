import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GEMINI_MODELS,
  GEMINI_PRICE_REVIEW,
  GEMINI_PRICE_SCHEDULE,
  GeminiProvider,
  LlmGateway,
  PRICES,
  checkGeminiModel,
  estimateCostUsd,
  geminiPrices,
  geminiResponseSchema,
  toStructuredSchema,
  geminiPricingApproved,
  type ProviderRequest,
  type LlmInvocationRecorder,
} from "../../packages/llm-gateway/src";
import { createLlmGateway, effectiveModels } from "../../apps/worker/src/llm";
import { parseWorkerEnv, parseWebEnv } from "../../packages/config/env";
import {
  BlueprintDraft,
  ComparisonNarrative,
  CritiqueReport,
  HypothesisBatch,
  HypothesisRevision,
  IntentFrame,
} from "../../packages/core/src";

const model = "gemini-3.5-flash-lite";
const request: ProviderRequest = {
  promptId: "r1.intent",
  model,
  system: "Return JSON",
  messages: [{ role: "user", content: "A public book cafe" }],
  jsonSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
  effort: "low",
  maxOutputTokens: 1000,
};
const response = (overrides = {}) => ({
  modelVersion: model,
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [
          { text: '{"answer":"ok"}' },
          { text: "private reasoning", thought: true },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 100,
    cachedContentTokenCount: 20,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 5,
    totalTokenCount: 115,
  },
  ...overrides,
});
function setup(
  overrides: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {},
  payload = response(),
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(payload)));
  const provider = new GeminiProvider({
    apiKey: "private-key-sentinel",
    model,
    freeTierConfirmed: true,
    dataSharingApproved: true,
    maxRequests: 4,
    fetch: fetcher,
    ...overrides,
  });
  return { provider, fetcher };
}
const recorder = (): LlmInvocationRecorder => ({
  record: vi.fn(async () => "invocation"),
});
const guard = () => ({
  reserve: vi.fn(async () => ({
    ok: true as const,
    reservationId: "reservation",
  })),
  settle: vi.fn(async () => {}),
});
const gatewayRequest = {
  role: "R1" as const,
  promptId: "r1.intent",
  input: { brief: "A public book cafe" },
  schema: z.object({ answer: z.string() }),
  effort: "low" as const,
  maxOutputTokens: 1000,
  ctx: {
    projectId: "p",
    runId: "r",
    remainingCalls: 3,
    inputOrigin: "synthetic" as const,
  },
};

describe("Gemini REST provider (mock network only)", () => {
  it("uses the fixed Google endpoint, header authentication, schema, role mapping, and counts thinking without retaining it", async () => {
    const { provider, fetcher } = setup();
    const result = await provider.generate({
      ...request,
      messages: [...request.messages, { role: "assistant", content: "{}" }],
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    );
    expect(url).not.toContain("private-key");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "x-goog-api-key": "private-key-sentinel" },
    });
    const body = JSON.parse(init!.body as string);
    expect(body.contents[1].role).toBe("model");
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: request.jsonSchema,
      maxOutputTokens: 1000,
    });
    expect(body).not.toHaveProperty("tools");
    expect(result).toMatchObject({
      text: '{"answer":"ok"}',
      modelId: model,
      stopReason: "end_turn",
      usage: {
        inputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteTokens: 0,
        outputTokens: 15,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });
  it.each([
    { freeTierConfirmed: false },
    { dataSharingApproved: false },
    { maxRequests: 0 },
    { maxRequests: 51 },
    { model: "claude-opus-5-5" },
  ])("fails closed before sending for %o", (options) => {
    expect(() => setup(options)).toThrow();
  });
  it("counts concurrent attempts against one hard cap, with no retry or model fallback", async () => {
    const { provider, fetcher } = setup({ maxRequests: 1 });
    const results = await Promise.allSettled([
      provider.generate(request),
      provider.generate(request),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      provider.generate({ ...request, model: "gemini-2.5-flash" }),
    ).rejects.toThrow("fallback is disabled");
  });
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "unavailable"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [400, "bad_request"],
  ])("redacts HTTP %s errors and sends exactly once", async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("private-key-sentinel private payload", {
        status: Number(status),
      }),
    );
    const { provider } = setup({ fetch: fetcher });
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind,
      status,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("pre-aborted calls send nothing; in-flight cancellation and deadlines abort fetch", async () => {
    const { provider, fetcher } = setup();
    await expect(
      provider.generate({ ...request, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fetcher).not.toHaveBeenCalled();
    const hanging: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private transport data")),
          { once: true },
        );
      });
    const timed = setup({ fetch: hanging, timeoutMs: 10 });
    // Sent but unanswered: possibly billed, so never retried automatically.
    await expect(timed.provider.generate(request)).rejects.toMatchObject({
      kind: "timeout",
      retryable: false,
      requestSent: true,
    });
    const controller = new AbortController();
    const cancelled = setup({ fetch: hanging }).provider.generate({
      ...request,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      kind: "timeout",
      retryable: false,
    });
  });
  it.each([
    { usageMetadata: undefined },
    {
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: -1,
        totalTokenCount: 0,
      },
    },
    {
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 11,
        candidatesTokenCount: 1,
        totalTokenCount: 11,
      },
    },
    { usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } },
    { modelVersion: undefined },
    {
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 1,
        totalTokenCount: 12,
      },
    },
  ])(
    "rejects incomplete or inconsistent usage/model metadata: %o",
    async (payload) => {
      await expect(
        setup({}, response(payload)).provider.generate(request),
      ).rejects.toMatchObject({ kind: "unknown" });
    },
  );
  it.each([
    ["SAFETY", "refusal"],
    ["RECITATION", "refusal"],
    ["MAX_TOKENS", "max_tokens"],
    ["OTHER", "other"],
  ])("maps finish reason %s", async (finishReason, expected) => {
    const payload = response({
      candidates: [
        { finishReason, content: { parts: [{ text: "untrusted" }] } },
      ],
    });
    const result = await setup({}, payload).provider.generate(request);
    expect(result.stopReason).toBe(expected);
    if (expected === "refusal") expect(result.text).toBe("");
  });
  it("recognizes prompt safety blocks without inventing generation usage", async () => {
    const payload = response({
      candidates: [],
      promptFeedback: { blockReason: "SAFETY" },
      modelVersion: undefined,
      usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
    });
    expect(await setup({}, payload).provider.generate(request)).toMatchObject({
      stopReason: "refusal",
      usage: { outputTokens: 0 },
    });
  });
  it("checks metadata with one GET, without representing it as a quota/billing check", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: `models/${model}`,
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: 1000,
          outputTokenLimit: 2000,
        }),
      ),
    );
    expect(
      await checkGeminiModel({
        model,
        apiKey: "private-key-sentinel",
        fetch: fetcher,
      }),
    ).toMatchObject({ model, billingVerified: false, quotaVerified: false });
    expect(fetcher.mock.calls[0]![1]!.method).toBe("GET");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini gateway and worker wiring", () => {
  it("keeps M10-A reservations and records free-tier usage and validated output", async () => {
    const { provider } = setup();
    const spendGuard = guard();
    const rec = recorder();
    const gateway = new LlmGateway({
      provider,
      primaryModel: model,
      spendGuard,
      recorder: rec,
    });
    const result = await gateway.generate(gatewayRequest);
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      costUsd: 0,
      usage: { outputTokens: 15 },
    });
    expect(spendGuard.reserve.mock.calls[0]).toBeDefined();
    expect(rec.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        validationStatus: "VALID",
        costUsd: 0,
      }),
    );
    expect(spendGuard.settle).toHaveBeenCalledWith("reservation", 0);
  });
  it("never sends without spending reservations, and never enables paid fallback", async () => {
    const { provider, fetcher } = setup({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 429 })),
    });
    const noGuard = new LlmGateway({ provider, primaryModel: model });
    expect(await noGuard.generate(gatewayRequest)).toMatchObject({
      ok: false,
      reason: "CONFIGURATION",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const withGuard = new LlmGateway({
      provider,
      primaryModel: model,
      fallbackModel: "claude-opus-5-5",
      mode: "economy",
      spendGuard: guard(),
    });
    expect(await withGuard.generate(gatewayRequest)).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
      attempts: 1,
      fallbackUsed: false,
    });
  });
  it("validates application schema and semantic rules, bounds repairs, and reserves each attempt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(response())));
    const { provider } = setup({ fetch: fetcher });
    const spendGuard = guard();
    const gateway = new LlmGateway({
      provider,
      primaryModel: model,
      spendGuard,
    });
    const result = await gateway.generate({
      ...gatewayRequest,
      validate: () => [{ code: "NO_CITATION", message: "Missing evidence" }],
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "INVALID_OUTPUT",
      attempts: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(spendGuard.reserve).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(body.contents.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });
  it("retains reservations when the provider returns an unexpected model", async () => {
    const { provider } = setup(
      {},
      response({ modelVersion: "unapproved-model" }),
    );
    const spendGuard = guard();
    const result = await new LlmGateway({
      provider,
      primaryModel: model,
      spendGuard,
    }).generate(gatewayRequest);
    expect(result).toMatchObject({ ok: false, reason: "CONFIGURATION" });
    expect(spendGuard.settle).toHaveBeenCalledWith("reservation", null);
  });
  it("fails closed for missing configuration even when an Anthropic key exists", () => {
    const settings = {
      LLM_PROVIDER: "gemini" as const,
      LLM_MODEL: model,
      LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
      LLM_MODE: "economy" as const,
      ANTHROPIC_API_KEY: "sentinel",
    };
    expect(createLlmGateway(settings, recorder())).toBeNull();
    expect(effectiveModels(settings)).toEqual({
      primary: model,
      fallback: model,
    });
    expect(
      createLlmGateway(
        {
          ...settings,
          GEMINI_API_KEY: "sentinel",
          GEMINI_FREE_TIER_CONFIRMED: "on",
          GEMINI_DATA_SHARING_APPROVED: "on",
          GEMINI_MAX_REQUESTS: 1,
        },
        recorder(),
      )?.providerName,
    ).toBe("gemini");
  });
  it("defaults live gates to off and refuses Gemini keys in web configuration", () => {
    const base = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://local:placeholder@localhost/test",
    };
    expect(parseWorkerEnv({ ...base, LLM_PROVIDER: "gemini" })).toMatchObject({
      GEMINI_MAX_REQUESTS: 0,
      GEMINI_FREE_TIER_CONFIRMED: "off",
      GEMINI_DATA_SHARING_APPROVED: "off",
    });
    expect(() =>
      parseWebEnv({ ...base, GEMINI_API_KEY: "private-value" }),
    ).toThrow("GEMINI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// Paid Tier: explicit approval, dated pricing, live-data gate (mock network only).

const NOW = Date.parse("2026-10-27T12:00:00Z");
const paid = (
  overrides: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {},
  payload: unknown = response(),
) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(payload)));
  const provider = new GeminiProvider({
    apiKey: "private-key-sentinel",
    model,
    paidTierApproved: true,
    pricingVerifiedAt: "2026-10-27T09:00:00Z",
    maxRequests: 4,
    fetch: fetcher,
    now: () => NOW,
    ...overrides,
  });
  return { provider, fetcher };
};

describe("Gemini pricing (Paid Tier Standard, reviewed 2026-10-26)", () => {
  it("prices every approved model with the published per-1M-token rates", () => {
    expect(geminiPrices(NOW)).toEqual({
      "gemini-4-argon": {
        input: 2,
        cacheWrite: 2,
        cacheRead: 0.1,
        output: 10,
      },
      "gemini-3.5-flash-lite": {
        input: 0.3,
        cacheWrite: 0.3,
        cacheRead: 0.03,
        output: 2.5,
      },
      "gemini-3.1-flash-lite": {
        input: 0.25,
        cacheWrite: 0.25,
        cacheRead: 0.025,
        output: 1.5,
      },
      "gemini-3.6-flash": {
        input: 0.75,
        cacheWrite: 0.75,
        cacheRead: 0.075,
        output: 3.75,
      },
      "gemini-3.8-flash": {
        input: 0.75,
        cacheWrite: 0.75,
        cacheRead: 0.075,
        output: 3.75,
      },
      "gemini-2.5-flash-lite": {
        input: 0.1,
        cacheWrite: 0.1,
        cacheRead: 0.01,
        output: 0.4,
      },
      "gemini-2.5-flash": {
        input: 0.3,
        cacheWrite: 0.3,
        cacheRead: 0.03,
        output: 2.5,
      },
    });
    for (const m of GEMINI_MODELS)
      expect(Object.keys(GEMINI_PRICE_SCHEDULE)).toContain(m);
  });
  it("applies the announced 2027-01-01 Flash increase at the UTC boundary", () => {
    const before = geminiPrices(Date.parse("2026-12-31T23:59:59.999Z"));
    const after = geminiPrices(Date.parse("2027-01-01T00:00:00Z"));
    for (const m of ["gemini-3.6-flash", "gemini-3.8-flash"]) {
      expect(before[m]).toMatchObject({ input: 0.75, output: 3.75 });
      expect(after[m]).toMatchObject({
        input: 1.5,
        cacheRead: 0.15,
        output: 7.5,
      });
    }
    expect(after["gemini-3.5-flash-lite"]).toEqual(
      before["gemini-3.5-flash-lite"],
    );
  });
  it("keeps scheduled-price models out of the clockless static table", () => {
    expect(PRICES["gemini-3.5-flash-lite"]).toEqual(
      geminiPrices(NOW)["gemini-3.5-flash-lite"],
    );
    expect(PRICES).not.toHaveProperty("gemini-3.6-flash");
    expect(PRICES).not.toHaveProperty("gemini-3.8-flash");
  });
  it("computes the cost of a call: uncached input, cache hits and output including thinking", () => {
    // 80 uncached × $0.30 + 20 cached × $0.03 + (10 + 5 thinking) × $2.50, per 1M tokens.
    expect(
      estimateCostUsd(
        model,
        {
          inputTokens: 80,
          cachedInputTokens: 20,
          cacheWriteTokens: 0,
          outputTokens: 15,
        },
        geminiPrices(NOW),
      ),
    ).toBeCloseTo(0.0000621, 12);
  });
  it("accepts a pricing review only from the review date, not in the future, for 90 days", () => {
    expect(GEMINI_PRICE_REVIEW).toBe("2026-10-26");
    expect(geminiPricingApproved("2026-10-26T00:00:00Z", NOW)).toBe(true);
    expect(geminiPricingApproved("2026-10-25T23:59:59Z", NOW)).toBe(false);
    expect(geminiPricingApproved("2026-10-28T00:00:00Z", NOW)).toBe(false);
    expect(geminiPricingApproved("not a date", NOW)).toBe(false);
    expect(
      geminiPricingApproved(
        "2026-10-27T00:00:00Z",
        Date.parse("2027-01-25T00:00:00Z"),
      ),
    ).toBe(true);
    expect(
      geminiPricingApproved(
        "2026-10-27T00:00:00Z",
        Date.parse("2027-01-25T00:00:01Z"),
      ),
    ).toBe(false);
  });
});

describe("Gemini paid tier provider", () => {
  it.each([
    { pricingVerifiedAt: undefined },
    { pricingVerifiedAt: "2026-10-01T00:00:00Z" },
    { freeTierConfirmed: true, dataSharingApproved: true },
    { paidTierApproved: false },
    { maxRequests: 5001 },
    { apiKey: "" },
  ])("fails closed before sending for %o", (options) => {
    expect(() => paid(options)).toThrow();
  });
  it("never lets the free tier carry live data or a paid-sized budget", () => {
    expect(() => setup({ liveInputsApproved: true })).toThrow();
    expect(() => setup({ maxRequests: 51 })).toThrow();
    expect(setup().provider).toMatchObject({
      billing: "confirmed-free-tier",
      liveInputsApproved: false,
    });
    expect(paid().provider.billing).toBeUndefined();
    expect(paid().provider.liveInputsApproved).toBe(false);
    expect(paid({ liveInputsApproved: true }).provider.liveInputsApproved).toBe(
      true,
    );
  });
  it.each(GEMINI_MODELS)(
    "%s: sends only fields Gemini 3 accepts (no candidateCount, sampling, thinking override, tools or service tier)",
    async (m) => {
      const { provider, fetcher } = paid(
        { model: m },
        response({ modelVersion: m }),
      );
      await provider.generate({ ...request, model: m });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(Object.keys(body).sort()).toEqual([
        "contents",
        "generationConfig",
        "systemInstruction",
      ]);
      // Regression: Gemini 3+ does not support candidateCount; 3.8 Flash rejects "minimal".
      expect(body.generationConfig).toEqual({
        maxOutputTokens: 1000,
        responseMimeType: "application/json",
        responseJsonSchema: request.jsonSchema,
      });
    },
  );
  it("bills tool-use prompt tokens as input and reports thinking tokens", async () => {
    const { provider } = paid(
      {},
      response({
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
          toolUsePromptTokenCount: 7,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 5,
          totalTokenCount: 122,
          serviceTier: "standard",
        },
      }),
    );
    expect((await provider.generate(request)).usage).toEqual({
      inputTokens: 87,
      cachedInputTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 15,
      reasoningTokens: 5,
    });
  });
  it.each(["priority", "SERVICE_TIER_PRIORITY", "flex"])(
    "rejects a %s-tier response and latches paid calls off",
    async (serviceTier) => {
      const payload = response();
      const { provider, fetcher } = paid(
        {},
        {
          ...payload,
          usageMetadata: { ...payload.usageMetadata, serviceTier },
        },
      );
      await expect(provider.generate(request)).rejects.toMatchObject({
        kind: "unknown",
      });
      await expect(provider.generate(request)).rejects.toMatchObject({
        requestSent: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("latches off after an unexpected serving model, inconsistent usage or an invalid envelope", async () => {
    for (const payload of [
      response({ modelVersion: "gemini-4-argon" }),
      response({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 1,
          totalTokenCount: 99,
        },
      }),
      { unexpected: true },
    ]) {
      const { provider, fetcher } = paid({}, payload);
      await provider.generate(request).catch(() => {});
      await expect(provider.generate(request)).rejects.toMatchObject({
        requestSent: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("resets the paid request cap at the UTC day boundary only", async () => {
    let now = Date.parse("2026-10-27T23:59:00Z");
    const { provider, fetcher } = paid({ maxRequests: 1, now: () => now });
    await provider.generate(request);
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind: "rate_limited",
      requestSent: false,
    });
    now = Date.parse("2026-10-28T00:00:01Z");
    await provider.generate(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("pauses paid calls without sending once the pricing review expires", async () => {
    let now = NOW;
    const { provider, fetcher } = paid({ now: () => now });
    await provider.generate(request);
    now = Date.parse("2027-01-26T00:00:00Z");
    await expect(provider.generate(request)).rejects.toMatchObject({
      kind: "bad_request",
      requestSent: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini paid tier through the gateway", () => {
  const gateway = (
    provider: GeminiProvider,
    spendGuard = guard(),
    now = () => NOW,
  ) =>
    new LlmGateway({
      provider,
      primaryModel: model,
      prices: () => geminiPrices(now()),
      spendGuard,
      recorder: recorder(),
    });

  it("reserves an upper bound first, then settles the actual paid cost", async () => {
    const spendGuard = guard();
    const result = await gateway(paid().provider, spendGuard).generate(
      gatewayRequest,
    );
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(result.costUsd).toBeCloseTo(0.0000621, 12);
    const [[reserved]] = spendGuard.reserve.mock.calls as unknown as [
      [{ upperBoundUsd: number }],
    ];
    expect(reserved.upperBoundUsd).toBeGreaterThan(result.costUsd);
    expect(spendGuard.settle).toHaveBeenCalledWith(
      "reservation",
      result.costUsd,
    );
  });
  it.each([undefined, "unknown" as const])(
    "refuses %s (non-synthetic) inputs before reserving or sending",
    async (inputOrigin) => {
      const { provider, fetcher } = paid();
      const spendGuard = guard();
      const result = await gateway(provider, spendGuard).generate({
        ...gatewayRequest,
        ctx: { ...gatewayRequest.ctx, inputOrigin },
      });
      expect(result).toMatchObject({
        ok: false,
        reason: "CONFIGURATION",
        attempts: 0,
        issues: [{ code: "DATA_SHARING_BLOCKED" }],
      });
      expect(spendGuard.reserve).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("blocks live inputs on the free tier as well", async () => {
    const { provider, fetcher } = setup();
    const result = await gateway(provider).generate({
      ...gatewayRequest,
      ctx: { ...gatewayRequest.ctx, inputOrigin: "unknown" },
    });
    expect(result).toMatchObject({ ok: false, reason: "CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends live inputs only after explicit live-data approval", async () => {
    const { provider, fetcher } = paid({ liveInputsApproved: true });
    const result = await gateway(provider).generate({
      ...gatewayRequest,
      ctx: { ...gatewayRequest.ctx, inputOrigin: "unknown" },
    });
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("prices reservation and settlement from one snapshot even across a price change", async () => {
    const flash = "gemini-3.6-flash";
    let now = Date.parse("2026-12-31T23:59:59Z");
    const { provider } = paid(
      { model: flash, now: () => now },
      response({ modelVersion: flash }),
    );
    const spendGuard = guard();
    spendGuard.reserve.mockImplementation(async () => {
      now = Date.parse("2027-01-01T00:00:01Z"); // the clock moves during the call
      return { ok: true as const, reservationId: "reservation" };
    });
    const result = await new LlmGateway({
      provider,
      primaryModel: flash,
      prices: () => geminiPrices(now),
      spendGuard,
    }).generate(gatewayRequest);
    // December rates: 80 × 0.75 + 20 × 0.075 + 15 × 3.75 per 1M tokens.
    expect(result.costUsd).toBeCloseTo(0.00011775, 12);
    const next = await new LlmGateway({
      provider,
      primaryModel: flash,
      prices: () => geminiPrices(now),
      spendGuard: guard(),
    }).generate(gatewayRequest);
    expect(next.costUsd).toBeCloseTo(0.0002355, 12);
  });
  it("rejects a scheduled-price model when no clock-aware price table is supplied", async () => {
    const flash = "gemini-3.8-flash";
    const { provider, fetcher } = paid(
      { model: flash },
      response({ modelVersion: flash }),
    );
    const result = await new LlmGateway({
      provider,
      primaryModel: flash,
      spendGuard: guard(),
    }).generate(gatewayRequest);
    expect(result).toMatchObject({
      ok: false,
      reason: "CONFIGURATION",
      issues: [{ code: "UNPRICED_MODEL" }],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Gemini paid tier worker configuration", () => {
  const base = {
    LLM_PROVIDER: "gemini" as const,
    LLM_MODEL: model,
    LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
    LLM_MODE: "standard" as const,
    GEMINI_API_KEY: "sentinel",
    GEMINI_MAX_REQUESTS: 200,
  };
  const reviewed = new Date().toISOString();

  it("builds a paid gateway only with explicit approval and a current pricing review", () => {
    expect(createLlmGateway(base, recorder())).toBeNull();
    expect(
      createLlmGateway(
        { ...base, GEMINI_PAID_TIER_APPROVED: "on" },
        recorder(),
      ),
    ).toBeNull();
    expect(
      createLlmGateway(
        {
          ...base,
          GEMINI_PAID_TIER_APPROVED: "on",
          GEMINI_PRICING_VERIFIED_AT: "2026-09-01T00:00:00Z",
        },
        recorder(),
      ),
    ).toBeNull();
    expect(
      createLlmGateway(
        {
          ...base,
          GEMINI_PAID_TIER_APPROVED: "on",
          GEMINI_FREE_TIER_CONFIRMED: "on",
          GEMINI_PRICING_VERIFIED_AT: reviewed,
        },
        recorder(),
      ),
    ).toBeNull();
    // Free tier: the paid-sized budget and live data are both refused.
    expect(
      createLlmGateway(
        {
          ...base,
          GEMINI_FREE_TIER_CONFIRMED: "on",
          GEMINI_DATA_SHARING_APPROVED: "on",
        },
        recorder(),
      ),
    ).toBeNull();
    const gateway = createLlmGateway(
      {
        ...base,
        GEMINI_PAID_TIER_APPROVED: "on",
        GEMINI_PRICING_VERIFIED_AT: reviewed,
        ANTHROPIC_API_KEY: "sentinel",
      },
      recorder(),
    );
    expect(gateway?.providerName).toBe("gemini");
  });
  it("records paid pricing context and never falls back to another provider", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(response())));
    vi.stubGlobal("fetch", fetcher);
    try {
      const rec = recorder();
      const spendGuard = guard();
      const gateway = createLlmGateway(
        {
          ...base,
          LLM_MODE: "economy",
          GEMINI_PAID_TIER_APPROVED: "on",
          GEMINI_PRICING_VERIFIED_AT: reviewed,
        },
        rec,
        undefined,
        spendGuard,
      )!;
      const result = await gateway.generate(gatewayRequest);
      expect(result).toMatchObject({ ok: true, fallbackUsed: false });
      expect(result.costUsd).toBeGreaterThan(0);
      expect(String(fetcher.mock.calls[0]![0])).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      );
      expect(rec.record).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          modelId: model,
          inputExcerpt: expect.objectContaining({
            billingTier: "paid",
            serviceTier: "standard",
            tariffSourceDate: GEMINI_PRICE_REVIEW,
            pricingVerifiedAt: reviewed,
            reasoningTokens: 5,
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("validates tier, pricing and live-data combinations in worker configuration", () => {
    const env = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://local:placeholder@localhost/test",
      LLM_PROVIDER: "gemini",
    };
    expect(parseWorkerEnv(env)).toMatchObject({
      GEMINI_PAID_TIER_APPROVED: "off",
      GEMINI_LIVE_DATA_APPROVED: "off",
      GEMINI_MAX_REQUESTS: 0,
    });
    for (const [bad, variable] of [
      [
        {
          GEMINI_PAID_TIER_APPROVED: "on",
          GEMINI_FREE_TIER_CONFIRMED: "on",
          GEMINI_PRICING_VERIFIED_AT: reviewed,
        },
        "GEMINI_PAID_TIER_APPROVED",
      ],
      [{ GEMINI_PAID_TIER_APPROVED: "on" }, "GEMINI_PRICING_VERIFIED_AT"],
      [
        { GEMINI_LIVE_DATA_APPROVED: "on", GEMINI_FREE_TIER_CONFIRMED: "on" },
        "GEMINI_LIVE_DATA_APPROVED",
      ],
      [
        { GEMINI_FREE_TIER_CONFIRMED: "on", GEMINI_MAX_REQUESTS: "51" },
        "GEMINI_MAX_REQUESTS",
      ],
      [{ GEMINI_MAX_REQUESTS: "5001" }, "GEMINI_MAX_REQUESTS"],
    ] as const)
      expect(() => parseWorkerEnv({ ...env, ...bad })).toThrow(variable);
    expect(
      parseWorkerEnv({
        ...env,
        GEMINI_PAID_TIER_APPROVED: "on",
        GEMINI_PRICING_VERIFIED_AT: reviewed,
        GEMINI_LIVE_DATA_APPROVED: "on",
        GEMINI_MAX_REQUESTS: "1000",
      }),
    ).toMatchObject({ GEMINI_MAX_REQUESTS: 1000 });
  });
  it("refuses the free tier and the Claude subscription in production", () => {
    const env = {
      APP_ENV: "production",
      DATABASE_URL:
        "postgresql://local:placeholder@db.example.test/prod?sslmode=verify-full",
      QLOO_MODE: "live",
    };
    expect(() =>
      parseWorkerEnv({
        ...env,
        LLM_PROVIDER: "gemini",
        GEMINI_FREE_TIER_CONFIRMED: "on",
      }),
    ).toThrow("GEMINI_FREE_TIER_CONFIRMED");
    expect(() =>
      parseWorkerEnv({ ...env, LLM_PROVIDER: "claude-subscription" }),
    ).toThrow("LLM_PROVIDER");
    expect(
      parseWorkerEnv({
        ...env,
        LLM_PROVIDER: "gemini",
        GEMINI_PAID_TIER_APPROVED: "on",
        GEMINI_PRICING_VERIFIED_AT: reviewed,
      }),
    ).toMatchObject({
      LLM_PROVIDER: "gemini",
      GEMINI_LIVE_DATA_APPROVED: "off",
    });
  });
});

// ---------------------------------------------------------------------------
// Structured output: only keywords Google documents for responseJsonSchema.

const GEMINI_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "format",
  "minimum",
  "maximum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "anyOf",
]);
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keywords(item, found));
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      if (key === "properties")
        Object.values(value as object).forEach((child) =>
          keywords(child, found),
        );
      else if (key !== "enum" && key !== "required") keywords(value, found);
    }
  return found;
}

describe("Gemini structured-output schema", () => {
  it("inlines local definitions, keeping sibling keywords", () => {
    expect(
      geminiResponseSchema({
        $defs: { id: { type: "string", format: "uuid" } },
        type: "object",
        properties: {
          a: { $ref: "#/$defs/id", description: "first" },
          list: { type: "array", items: { $ref: "#/$defs/id" } },
        },
        required: ["a", "list"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: 'first {format: "uuid"}' },
        list: {
          type: "array",
          items: { type: "string", description: '{format: "uuid"}' },
        },
      },
      required: ["a", "list"],
    });
  });
  it("keeps documented formats and property names that look like keywords", () => {
    expect(
      geminiResponseSchema({
        type: "object",
        properties: {
          $ref: { type: "string", format: "date-time" },
          format: { type: "string" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        $ref: { type: "string", format: "date-time" },
        format: { type: "string" },
      },
    });
  });
  it.each([
    { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" },
    { type: "object", properties: { x: { $ref: "#/$defs/missing" } } },
    { type: "object", properties: { x: { $ref: "https://example.test/s" } } },
  ])(
    "refuses cyclic, missing or remote references without sending",
    async (schema) => {
      expect(() => geminiResponseSchema(schema)).toThrow("reference");
      const { provider, fetcher } = paid();
      await expect(
        provider.generate({ ...request, jsonSchema: schema }),
      ).rejects.toMatchObject({ kind: "bad_request", requestSent: false });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["R1 intent", IntentFrame],
    ["R3 generation", HypothesisBatch],
    ["R4 critique", CritiqueReport],
    ["R3 revision", HypothesisRevision],
    ["R5 comparison", ComparisonNarrative],
    ["R6 blueprint", BlueprintDraft],
  ] as const)(
    "%s schema reaches Gemini with documented keywords only and stays small",
    async (_role, schema) => {
      const structured = toStructuredSchema(schema);
      const sent = geminiResponseSchema(structured);
      for (const key of keywords(sent))
        expect(GEMINI_KEYWORDS, key).toContain(key);
      const text = JSON.stringify(sent);
      expect(text).not.toContain('"format":"uuid"');
      expect(text.length).toBeLessThan(16_384);
      // The request carries the normalized schema, not the original.
      const { provider, fetcher } = paid();
      await provider.generate({ ...request, jsonSchema: structured });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(body.generationConfig.responseJsonSchema).toEqual(sent);
    },
  );
});

// ---------------------------------------------------------------------------
// Gemini 4 Argon (official ID verified 2026-10-27; paid only).

describe("Gemini 4 Argon", () => {
  const argon = "gemini-4-argon";
  it("is paid-only: the free tier refuses it before any request", () => {
    expect(() => setup({ model: argon })).toThrow();
    expect(paid({ model: argon }).provider.billing).toBeUndefined();
  });
  it("doubles its rates on 2026-12-01 at the UTC boundary", () => {
    expect(geminiPrices(Date.parse("2026-11-30T23:59:59.999Z"))[argon]).toEqual(
      { input: 2, cacheWrite: 2, cacheRead: 0.1, output: 10 },
    );
    expect(geminiPrices(Date.parse("2026-12-01T00:00:00Z"))[argon]).toEqual({
      input: 4,
      cacheWrite: 4,
      cacheRead: 0.2,
      output: 20,
    });
    expect(PRICES).not.toHaveProperty(argon);
  });
  it("bills thinking as output at Argon rates (Nov 2026)", () => {
    // 80 uncached × $2 + 20 cached × $0.10 + (10 + 5 thinking) × $10, per 1M tokens.
    expect(
      estimateCostUsd(
        argon,
        {
          inputTokens: 80,
          cachedInputTokens: 20,
          cacheWriteTokens: 0,
          outputTokens: 15,
          reasoningTokens: 5,
        },
        geminiPrices(NOW),
      ),
    ).toBeCloseTo(0.000312, 12);
  });
  it.each([
    [argon, "high", true],
    [argon, "low", true],
    ["gemini-3.8-flash", "medium", true],
    ["gemini-3.1-flash-lite", "low", false],
    ["gemini-2.5-flash", "low", false],
  ] as const)(
    "%s with thinkingLevel %s is accepted: %s",
    async (m, level, ok) => {
      const make = () =>
        paid({ model: m, thinkingLevel: level }, response({ modelVersion: m }));
      if (!ok) return expect(make).toThrow();
      const { provider, fetcher } = make();
      await provider.generate({ ...request, model: m });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: level,
      });
    },
  );
});

describe("duplicate paid requests", () => {
  const gw = (fetcher: typeof fetch) =>
    new LlmGateway({
      provider: paid({ fetch: fetcher, timeoutMs: 20 }).provider,
      primaryModel: model,
      prices: () => geminiPrices(NOW),
      spendGuard: guard(),
    });
  it("reports a timed-out (possibly billed) request as not retryable", async () => {
    const hanging: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("x")), {
          once: true,
        }),
      );
    expect(await gw(hanging).generate(gatewayRequest)).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
      retryable: false,
      attempts: 1,
    });
  });
  it.each([429, 500, 503])(
    "reports an HTTP %s (no generation billed) as retryable",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status }));
      expect(await gw(fetcher).generate(gatewayRequest)).toMatchObject({
        ok: false,
        reason: "UNAVAILABLE",
        retryable: true,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps every Gemini deadline inside the run-step queue expiry", async () => {
    const { RUN_STEP_EXPIRE_SECONDS } =
      await import("../../packages/db/src/queue");
    const env = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://local:placeholder@localhost/test",
    };
    expect(() =>
      parseWorkerEnv({ ...env, GEMINI_TIMEOUT_MS: "120001" }),
    ).toThrow("GEMINI_TIMEOUT_MS");
    // First attempt + one truncation retry + one repair, each at the maximum deadline,
    // with a minute of margin for Qloo and database work in the same step.
    expect(3 * 120 + 60).toBeLessThan(RUN_STEP_EXPIRE_SECONDS);
    expect(() => paid({ timeoutMs: 120_001 })).toThrow();
  });
});

describe("content-free diagnosis of failed Gemini requests", () => {
  const fails = (fetcher: typeof fetch) =>
    paid({ fetch: fetcher }).provider.generate(request);
  it.each([
    [
      "connection",
      (async () => {
        throw Object.assign(new TypeError("fetch failed: private detail"), {
          cause: Object.assign(new Error("socket private-key-sentinel"), {
            code: "UND_ERR_SOCKET",
          }),
        });
      }) as typeof fetch,
      "Gemini connection failed (UND_ERR_SOCKET)",
    ],
    [
      "body",
      (async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(
                Object.assign(new Error("reset"), { code: "ECONNRESET" }),
              );
            },
          }),
        )) as typeof fetch,
      "Gemini response body failed (ECONNRESET)",
    ],
    [
      "JSON",
      (async () =>
        new Response("<html>private payload</html>")) as typeof fetch,
      "Gemini response JSON failed",
    ],
  ])(
    "names the failing %s step without content",
    async (_n, fetcher, message) => {
      const error = await fails(fetcher).catch((e) => e);
      expect(error).toMatchObject({
        kind: "unavailable",
        retryable: false,
        requestSent: true,
        message,
      });
      expect(error.message).not.toMatch(/private|sentinel|html/);
    },
  );
  it("records the provider's message on the failed invocation", async () => {
    const rec = recorder();
    await new LlmGateway({
      provider: paid({
        fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
      }).provider,
      primaryModel: model,
      prices: () => geminiPrices(NOW),
      spendGuard: guard(),
      recorder: rec,
    }).generate(gatewayRequest);
    expect(rec.record).toHaveBeenCalledWith(
      expect.objectContaining({
        validationErrors: expect.arrayContaining([
          {
            code: "PROVIDER_UNAVAILABLE",
            message: "Gemini request failed (404)",
          },
        ]),
      }),
    );
  });
});
