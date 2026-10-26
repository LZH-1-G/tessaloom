import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderUsage,
} from "../types";

/**
 * LOCAL PERSONAL-USE ONLY. Runs the owner's own, unmodified Claude Code binary (bundled with the
 * official Agent SDK) signed in with the owner's own Claude subscription. Anthropic does not
 * permit offering claude.ai login to other users or routing other users' requests through Free,
 * Pro or Max credentials, so this provider is refused in production/staging, never handles a
 * credential itself, and fails closed unless the CLI reports subscription (non-API-key) auth.
 * Public deployments must use `AnthropicProvider` with a Claude Console API key.
 */
export const CLAUDE_SUBSCRIPTION_MODELS = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
] as const;
// accountInfo() reports display names such as "Claude Pro"; only the owner's personal plans.
const SUBSCRIPTION_PLAN = /^(?:claude\s+)?(?:pro|max)\b/i;
const SDK_MODULE = "@anthropic-ai/claude-agent-sdk";

// Structural subset of the Agent SDK surface used here; a fake implements it in tests.
export interface AgentSdkAccountInfo {
  subscriptionType?: string;
  apiKeySource?: string;
  apiProvider?: string;
}
export interface AgentSdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
export type AgentSdkMessage =
  | { type: "system"; subtype: "init"; apiKeySource: string; model: string }
  | {
      type: "rate_limit_event";
      rate_limit_info: {
        status: string;
        rateLimitType?: string;
        isUsingOverage?: boolean;
        overageInUse?: boolean;
      };
    }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      stop_reason: string | null;
      result?: string;
      structured_output?: unknown;
      modelUsage: Record<string, AgentSdkModelUsage>;
    }
  | { type: string; subtype?: string };
export interface AgentSdkUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}
export interface AgentSdkQuery extends AsyncIterable<AgentSdkMessage> {
  accountInfo(): Promise<AgentSdkAccountInfo>;
  close(): void;
}
export type AgentSdkQueryFn = (params: {
  prompt: AsyncIterable<AgentSdkUserMessage>;
  options: Record<string, unknown>;
}) => AgentSdkQuery;

export interface ClaudeSubscriptionProviderOptions {
  /** Owner opt-in for local personal-use runs; the worker also refuses production/staging. */
  localPersonalUseApproved: boolean;
  /** Hard cap across concurrent calls, repairs included, for this worker lifetime. */
  maxRequests: number;
  timeoutMs?: number;
  /** Test seam; defaults to the official SDK's `query`, loaded lazily (never bundled). */
  query?: AgentSdkQueryFn;
  /** Host environment the CLI child inherits from (only allowlisted names are copied). */
  env?: Record<string, string | undefined>;
}

// The CLI child gets only what it needs to find the owner's own login. API keys, bearer
// tokens, OAuth overrides, base URLs and provider switches are never forwarded, so a stray
// key cannot silently turn this into paid API billing.
const CHILD_ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"];

export class ClaudeSubscriptionProvider implements LlmProvider {
  readonly name = "claude-subscription";
  readonly billing = "claude-subscription" as const;
  private requests = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClaudeSubscriptionProviderOptions) {
    if (!options.localPersonalUseApproved)
      throw new Error("Claude subscription mode requires local owner approval");
    if (
      !Number.isSafeInteger(options.maxRequests) ||
      options.maxRequests < 1 ||
      options.maxRequests > 30
    )
      throw new Error("Claude subscription mode requires a request cap");
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  private async loadQuery(): Promise<AgentSdkQueryFn> {
    if (this.options.query) return this.options.query;
    try {
      const sdk = (await import(/* @vite-ignore */ SDK_MODULE)) as {
        query: AgentSdkQueryFn;
      };
      return sdk.query;
    } catch {
      throw new ProviderError(
        "unavailable",
        "Agent SDK is not installed (local development dependency only)",
        false,
        undefined,
        false,
      );
    }
  }

  childEnv(maxOutputTokens: number): Record<string, string> {
    const source = this.options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const key of CHILD_ENV_ALLOWLIST) {
      const value = source[key];
      if (value) env[key] = value;
    }
    return {
      ...env,
      PATH: "/usr/bin:/bin",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
      // Without this the CLI adds an auxiliary Haiku call; only the requested model may serve.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "tessaloom-local/0.0.0",
    };
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (
      !(CLAUDE_SUBSCRIPTION_MODELS as readonly string[]).includes(request.model)
    )
      throw new ProviderError(
        "bad_request",
        "Model is not approved for subscription mode",
        false,
        undefined,
        false,
      );
    if (request.messages[0]?.role !== "user")
      throw new ProviderError(
        "bad_request",
        "Conversation must start with a user turn",
        false,
        undefined,
        false,
      );
    if (this.requests >= this.options.maxRequests)
      throw new ProviderError(
        "rate_limited",
        "Subscription request cap reached",
        false,
        undefined,
        false,
      );
    const query = await this.loadQuery();
    this.requests += 1;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    // An empty working directory: no project memory, skills or files reach the model.
    const cwd = await mkdtemp(path.join(tmpdir(), "tessaloom-claude-"));

    // The user turn is withheld until the account check passes, so nothing is sent to the
    // model on API-key, Console-key, third-party or unknown authentication.
    let release!: (send: boolean) => void;
    const gate = new Promise<boolean>((resolve) => (release = resolve));
    const content = flattenTurns(request.messages);
    async function* prompt(): AsyncIterable<AgentSdkUserMessage> {
      if (await gate)
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
        };
    }

    const q = query({
      prompt: prompt(),
      options: {
        abortController: abort,
        cwd,
        model: request.model,
        systemPrompt: request.system,
        outputFormat: { type: "json_schema", schema: request.jsonSchema },
        effort: request.effort,
        thinking: { type: "adaptive" },
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        env: this.childEnv(request.maxOutputTokens),
      },
    });

    let sent = false;
    try {
      let account: AgentSdkAccountInfo;
      try {
        account = await q.accountInfo();
      } catch {
        throw new ProviderError(
          "auth",
          "Claude account check failed",
          false,
          undefined,
          false,
        );
      }
      if (
        account.apiProvider !== "firstParty" ||
        (account.apiKeySource !== undefined &&
          account.apiKeySource !== "none") ||
        !SUBSCRIPTION_PLAN.test(account.subscriptionType ?? "")
      )
        throw new ProviderError(
          "auth",
          "Claude CLI is not on subscription authentication",
          false,
          undefined,
          false,
        );
      sent = true;
      release(true);

      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          const init = message as { apiKeySource: string };
          if (init.apiKeySource !== "none")
            throw new ProviderError(
              "auth",
              "Claude CLI switched to API-key authentication",
              false,
            );
        } else if (message.type === "rate_limit_event") {
          const info = (
            message as Extract<AgentSdkMessage, { type: "rate_limit_event" }>
          ).rate_limit_info;
          // Paid extra usage is never used silently; an exhausted allowance stops the run.
          if (
            info.isUsingOverage ||
            info.overageInUse ||
            info.rateLimitType === "overage"
          )
            throw new ProviderError(
              "rate_limited",
              "Subscription allowance exhausted; paid extra usage refused",
              false,
            );
          if (info.status === "rejected")
            throw new ProviderError(
              "rate_limited",
              "Subscription usage limit reached",
              false,
            );
        } else if (message.type === "result") {
          return toResponse(
            request.model,
            message as Extract<AgentSdkMessage, { type: "result" }>,
          );
        }
      }
      throw new ProviderError(
        "unknown",
        "Claude CLI ended without a result",
        false,
      );
    } catch (error) {
      if (signal.aborted)
        throw new ProviderError(
          "timeout",
          request.signal?.aborted
            ? "LLM request aborted"
            : "LLM request timed out",
          false,
          undefined,
          sent,
        );
      if (error instanceof ProviderError)
        throw new ProviderError(
          error.kind,
          error.message,
          error.retryable,
          error.status,
          error.requestSent && sent,
        );
      throw new ProviderError(
        "unknown",
        "Claude CLI call failed",
        false,
        undefined,
        sent,
      );
    } finally {
      release(false);
      signal.removeEventListener("abort", onAbort);
      q.close();
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Repairs replay earlier turns; one SDK prompt carries them as labelled transcript blocks. */
export function flattenTurns(messages: ProviderRequest["messages"]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) => `<${m.role}_turn>\n${m.content}\n</${m.role}_turn>`)
    .join("\n\n");
}

function toResponse(
  model: string,
  result: Extract<AgentSdkMessage, { type: "result" }>,
): ProviderResponse {
  const models = Object.keys(result.modelUsage ?? {});
  // Any other model (auxiliary call, server fallback) is reported so the gateway fails closed.
  const servedBy = models.length === 1 ? models[0]! : `${model}+unexpected`;
  const u = result.modelUsage?.[models[0] ?? ""];
  const usage: ProviderUsage = {
    inputTokens: u?.inputTokens ?? 0,
    cachedInputTokens: u?.cacheReadInputTokens ?? 0,
    cacheWriteTokens: u?.cacheCreationInputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    ...(u?.thinkingTokens !== undefined
      ? { reasoningTokens: u.thinkingTokens }
      : {}),
  };
  if (result.subtype === "success" && result.structured_output !== undefined)
    return {
      text: JSON.stringify(result.structured_output),
      stopReason: "end_turn",
      modelId: servedBy,
      usage,
    };
  if (result.stop_reason === "refusal")
    return { text: "", stopReason: "refusal", modelId: servedBy, usage };
  if (result.stop_reason === "max_tokens")
    return { text: "", stopReason: "max_tokens", modelId: servedBy, usage };
  if (
    result.subtype === "error_max_structured_output_retries" ||
    result.subtype === "error_max_turns" ||
    result.subtype === "success"
  )
    // No schema-valid output: the gateway's validator treats this as INVALID_OUTPUT.
    return { text: "", stopReason: "other", modelId: servedBy, usage };
  throw new ProviderError("unavailable", "Claude CLI run failed", false);
}
