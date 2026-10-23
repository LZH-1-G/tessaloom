import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GeminiProvider,
  LlmGateway,
  checkGeminiModel,
  type ProviderRequest,
  type LlmInvocationRecorder,
} from "../../packages/llm-gateway/src";
import { createLlmGateway, effectiveModels } from "../../apps/worker/src/llm";
import { parseWorkerEnv, parseWebEnv } from "../../packages/config/env";

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
  ctx: { projectId: "p", runId: "r", remainingCalls: 3 },
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
    expect(body.generationConfig).toMatchObject({
      responseJsonSchema: request.jsonSchema,
      maxOutputTokens: 1000,
      candidateCount: 1,
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
    await expect(timed.provider.generate(request)).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
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
