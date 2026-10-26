import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ClaudeSubscriptionProvider,
  LlmGateway,
  flattenTurns,
  type AgentSdkAccountInfo,
  type AgentSdkMessage,
  type AgentSdkQueryFn,
  type AgentSdkUserMessage,
  type ProviderRequest,
  type LlmInvocationRecorder,
} from "../../packages/llm-gateway/src";
import { createLlmGateway } from "../../apps/worker/src/llm";
import { parseWorkerEnv } from "../../packages/config/env";

const model = "claude-sonnet-5-5";
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
const subscription: AgentSdkAccountInfo = {
  subscriptionType: "Claude Pro",
  apiKeySource: "none",
  apiProvider: "firstParty",
};
const usage = {
  inputTokens: 40,
  outputTokens: 15,
  thinkingTokens: 5,
  cacheReadInputTokens: 2,
  cacheCreationInputTokens: 3,
};
const success = (overrides: Record<string, unknown> = {}): AgentSdkMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  structured_output: { answer: "ok" },
  modelUsage: { [model]: usage },
  ...overrides,
});

/** Fake SDK: records options and whether the gated user turn was ever released. */
function fakeSdk(
  options: {
    account?: AgentSdkAccountInfo | Error;
    messages?: AgentSdkMessage[];
  } = {},
) {
  const sent: AgentSdkUserMessage[] = [];
  const calls: Record<string, unknown>[] = [];
  const closed = vi.fn();
  const query: AgentSdkQueryFn = ({ prompt, options: opts }) => {
    calls.push(opts);
    const messages = options.messages ?? [
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        model,
      } as AgentSdkMessage,
      success(),
    ];
    return {
      accountInfo: async () => {
        const account = options.account ?? subscription;
        if (account instanceof Error) throw account;
        return account;
      },
      close: closed,
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) sent.push(message);
        if (!sent.length) return;
        yield* messages;
      },
    };
  };
  return { query, sent, calls, closed };
}

const provider = (
  sdk: ReturnType<typeof fakeSdk>,
  extra: Partial<
    ConstructorParameters<typeof ClaudeSubscriptionProvider>[0]
  > = {},
) =>
  new ClaudeSubscriptionProvider({
    localPersonalUseApproved: true,
    maxRequests: 2,
    query: sdk.query,
    env: {
      HOME: "/home/owner",
      USER: "owner",
      PATH: "/untrusted/bin",
      ANTHROPIC_API_KEY: "sentinel-api-key",
      ANTHROPIC_AUTH_TOKEN: "sentinel-bearer",
      ANTHROPIC_BASE_URL: "https://proxy.invalid",
      CLAUDE_CODE_OAUTH_TOKEN: "sentinel-oauth",
    },
    ...extra,
  });

describe("ClaudeSubscriptionProvider", () => {
  it("requires local approval and a bounded request cap", () => {
    const sdk = fakeSdk();
    expect(
      () =>
        new ClaudeSubscriptionProvider({
          localPersonalUseApproved: false,
          maxRequests: 1,
          query: sdk.query,
        }),
    ).toThrow("approval");
    for (const maxRequests of [0, 31, 1.5])
      expect(
        () =>
          new ClaudeSubscriptionProvider({
            localPersonalUseApproved: true,
            maxRequests,
            query: sdk.query,
          }),
      ).toThrow("cap");
  });

  it("returns structured output with usage from the requested model only", async () => {
    const sdk = fakeSdk();
    const response = await provider(sdk).generate(request);
    expect(response).toEqual({
      text: '{"answer":"ok"}',
      stopReason: "end_turn",
      modelId: model,
      usage: {
        inputTokens: 40,
        cachedInputTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 15,
        reasoningTokens: 5,
      },
    });
    expect(sdk.sent).toHaveLength(1);
    expect(sdk.closed).toHaveBeenCalled();
  });

  it("runs with no tools, settings, MCP, persistence, or credentials in the child", async () => {
    const sdk = fakeSdk();
    await provider(sdk).generate(request);
    const opts = sdk.calls[0]!;
    expect(opts).toMatchObject({
      model,
      systemPrompt: "Return JSON",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      outputFormat: { type: "json_schema", schema: request.jsonSchema },
    });
    expect(opts).not.toHaveProperty("fallbackModel");
    expect(opts.env).toEqual({
      HOME: "/home/owner",
      USER: "owner",
      PATH: "/usr/bin:/bin",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "tessaloom-local/0.0.0",
    });
    expect(JSON.stringify(opts)).not.toContain("sentinel");
  });

  it.each([
    ["API key", { ...subscription, apiKeySource: "ANTHROPIC_API_KEY" }],
    ["Console key", { ...subscription, apiKeySource: "/login managed key" }],
    ["third-party cloud", { ...subscription, apiProvider: "bedrock" }],
    ["no plan", { ...subscription, subscriptionType: undefined }],
    ["free plan", { ...subscription, subscriptionType: "Claude Free" }],
    ["organization plan", { ...subscription, subscriptionType: "Claude Team" }],
    ["lookalike plan", { ...subscription, subscriptionType: "professional" }],
  ])("never sends the prompt on %s authentication", async (_, account) => {
    const sdk = fakeSdk({ account });
    await expect(provider(sdk).generate(request)).rejects.toMatchObject({
      kind: "auth",
      requestSent: false,
    });
    expect(sdk.sent).toHaveLength(0);
  });

  it.each(["pro", "max", "Claude Max", { apiKeySource: undefined }])(
    "accepts the owner's personal plan as reported (%s)",
    async (variant) => {
      const sdk = fakeSdk({
        account:
          typeof variant === "string"
            ? { ...subscription, subscriptionType: variant }
            : { ...subscription, ...variant },
      });
      await expect(provider(sdk).generate(request)).resolves.toMatchObject({
        stopReason: "end_turn",
      });
    },
  );

  it("fails closed when the account check itself fails", async () => {
    const sdk = fakeSdk({ account: new Error("socket") });
    await expect(provider(sdk).generate(request)).rejects.toMatchObject({
      kind: "auth",
      requestSent: false,
    });
    expect(sdk.sent).toHaveLength(0);
  });

  it("refuses paid extra usage and an exhausted allowance", async () => {
    for (const info of [
      { status: "allowed", isUsingOverage: true },
      { status: "allowed", rateLimitType: "overage" },
      { status: "rejected", rateLimitType: "five_hour" },
    ]) {
      const sdk = fakeSdk({
        messages: [
          {
            type: "rate_limit_event",
            rate_limit_info: info,
          } as AgentSdkMessage,
          success(),
        ],
      });
      await expect(provider(sdk).generate(request)).rejects.toMatchObject({
        kind: "rate_limited",
        retryable: false,
        requestSent: true,
      });
    }
  });

  it("rejects an init that reports API-key authentication", async () => {
    const sdk = fakeSdk({
      messages: [
        {
          type: "system",
          subtype: "init",
          apiKeySource: "ANTHROPIC_API_KEY",
          model,
        } as AgentSdkMessage,
        success(),
      ],
    });
    await expect(provider(sdk).generate(request)).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("enforces the request cap before contacting the CLI", async () => {
    const sdk = fakeSdk();
    const p = provider(sdk, { maxRequests: 1 });
    await p.generate(request);
    await expect(p.generate(request)).rejects.toMatchObject({
      kind: "rate_limited",
      requestSent: false,
    });
    expect(sdk.calls).toHaveLength(1);
  });

  it("holds the cap for concurrent calls", async () => {
    const sdk = fakeSdk();
    const p = provider(sdk, { maxRequests: 1 });
    const results = await Promise.allSettled([
      p.generate(request),
      p.generate(request),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(sdk.calls).toHaveLength(1);
  });

  it("rejects unapproved models without sending", async () => {
    const sdk = fakeSdk();
    await expect(
      provider(sdk).generate({ ...request, model: "claude-haiku-5-5" }),
    ).rejects.toMatchObject({ kind: "bad_request", requestSent: false });
    expect(sdk.calls).toHaveLength(0);
  });

  it("reports additional serving models so the gateway fails closed", async () => {
    const sdk = fakeSdk({
      messages: [
        success({ modelUsage: { [model]: usage, "claude-haiku-5-5": usage } }),
      ],
    });
    expect((await provider(sdk).generate(request)).modelId).not.toBe(model);
  });

  it("maps missing structured output, refusal and truncation", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          subtype: "error_max_structured_output_retries",
          structured_output: undefined,
        },
        "other",
      ],
      [{ stop_reason: "refusal", structured_output: undefined }, "refusal"],
      [
        { stop_reason: "max_tokens", structured_output: undefined },
        "max_tokens",
      ],
    ];
    for (const [overrides, stopReason] of cases) {
      const sdk = fakeSdk({ messages: [success(overrides)] });
      expect(await provider(sdk).generate(request)).toMatchObject({
        text: "",
        stopReason,
      });
    }
    const sdk = fakeSdk({
      messages: [
        success({ subtype: "error_during_execution", is_error: true }),
      ],
    });
    await expect(provider(sdk).generate(request)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("flattens repair turns into one labelled prompt", () => {
    expect(flattenTurns(request.messages)).toBe("A public book cafe");
    expect(
      flattenTurns([
        { role: "user", content: "task" },
        { role: "assistant", content: "{}" },
        { role: "user", content: "fix" },
      ]),
    ).toBe(
      "<user_turn>\ntask\n</user_turn>\n\n<assistant_turn>\n{}\n</assistant_turn>\n\n<user_turn>\nfix\n</user_turn>",
    );
  });
});

describe("Claude subscription gateway and deployment gates", () => {
  const recorder = (): LlmInvocationRecorder & {
    record: ReturnType<typeof vi.fn>;
  } => ({ record: vi.fn().mockResolvedValue("invocation") });
  const guard = () => ({
    reserve: vi
      .fn()
      .mockResolvedValue({ ok: true, reservationId: "reservation" }),
    settle: vi.fn().mockResolvedValue(undefined),
  });

  it("reserves, then settles at zero API charge and records the list-price equivalent", async () => {
    const spendGuard = guard();
    const rec = recorder();
    const result = await new LlmGateway({
      provider: provider(fakeSdk()),
      primaryModel: model,
      fallbackModel: "claude-opus-5-5",
      spendGuard,
      recorder: rec,
    }).generate({
      role: "R1",
      promptId: "r1.intent",
      input: { brief: "A public book cafe" },
      schema: z.object({ answer: z.string() }),
      effort: "low",
      maxOutputTokens: 1000,
      ctx: { projectId: "p", runId: "r" },
    });
    expect(result).toMatchObject({ ok: true, costUsd: 0, fallbackUsed: false });
    expect(spendGuard.reserve.mock.calls[0]?.[0].upperBoundUsd).toBeGreaterThan(
      0,
    );
    expect(spendGuard.settle).toHaveBeenCalledWith("reservation", 0);
    const recorded = rec.record.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({
      provider: "claude-subscription",
      costUsd: 0,
      inputExcerpt: { billing: "claude-subscription" },
    });
    expect(recorded.inputExcerpt.notionalApiListUsd).toBeGreaterThan(0);
  });

  const settings = {
    APP_ENV: "development" as const,
    LLM_PROVIDER: "claude-subscription" as const,
    LLM_MODEL: model,
    LLM_FALLBACK_MODEL: "claude-opus-5-5",
    LLM_MODE: "standard" as const,
    CLAUDE_SUBSCRIPTION_LOCAL_APPROVED: "on" as const,
    CLAUDE_SUBSCRIPTION_MAX_REQUESTS: 4,
  };

  it("builds only for approved local development and never beside an API key", () => {
    expect(createLlmGateway(settings, recorder())?.providerName).toBe(
      "claude-subscription",
    );
    for (const override of [
      { APP_ENV: "production" as const },
      { APP_ENV: "staging" as const },
      { CLAUDE_SUBSCRIPTION_LOCAL_APPROVED: "off" as const },
      { CLAUDE_SUBSCRIPTION_MAX_REQUESTS: 0 },
      { LLM_MODEL: "claude-haiku-5-5" },
      { ANTHROPIC_API_KEY: "sentinel" },
    ])
      expect(
        createLlmGateway({ ...settings, ...override }, recorder()),
      ).toBeNull();
  });

  it("rejects subscription mode in deployed environments and beside an API key", () => {
    const base = {
      DATABASE_URL: "postgresql://local:placeholder@localhost/test",
      LLM_PROVIDER: "claude-subscription",
    };
    expect(parseWorkerEnv({ ...base, APP_ENV: "development" })).toMatchObject({
      CLAUDE_SUBSCRIPTION_LOCAL_APPROVED: "off",
      CLAUDE_SUBSCRIPTION_MAX_REQUESTS: 0,
    });
    expect(() =>
      parseWorkerEnv({
        ...base,
        APP_ENV: "staging",
        DATABASE_URL:
          "postgresql://local:placeholder@localhost/test?sslmode=require",
      }),
    ).toThrow("LLM_PROVIDER");
    expect(() =>
      parseWorkerEnv({
        ...base,
        APP_ENV: "development",
        ANTHROPIC_API_KEY: "sentinel",
      }),
    ).toThrow("ANTHROPIC_API_KEY");
  });
});
