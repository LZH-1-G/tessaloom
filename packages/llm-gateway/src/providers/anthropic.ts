import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
  type StopReason,
} from "../types";

/** Requests above this output cap are streamed to avoid HTTP timeouts on long generations. */
export const STREAM_THRESHOLD_TOKENS = 16_000;
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The subset of the SDK client the provider uses; a fake implements it in tests. */
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      create(
        params: MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
      ): PromiseLike<BetaMessage>;
      stream(
        params: MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
      ): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

export interface AnthropicProviderOptions {
  /** Worker-only secret. Never logged, never sent to the web process. */
  apiKey?: string;
  client?: AnthropicMessagesClient;
  /** Server-side fallback on refusal/overload (ADR-018). */
  serverSideFallback?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

const KNOWN_STOPS = new Set<StopReason>([
  "end_turn",
  "max_tokens",
  "refusal",
  "stop_sequence",
  "pause_turn",
  "tool_use",
]);

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: AnthropicMessagesClient;
  private readonly serverSideFallback: boolean;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (options.serverSideFallback || (options.maxRetries ?? 0) !== 0)
      throw new Error(
        "Retries and fallback must pass through the spending guard",
      );
    this.serverSideFallback = false;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.apiKey)
        throw new Error("AnthropicProvider requires an API key");
      this.client = new Anthropic({
        apiKey: options.apiKey,
        maxRetries: 0,
        timeout: this.timeoutMs,
      }) as unknown as AnthropicMessagesClient;
    }
  }

  buildParams(request: ProviderRequest): MessageCreateParamsNonStreaming {
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      // The role instructions are the stable prefix; caching them cuts repeat-call cost.
      system: [
        {
          type: "text",
          text: request.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      // Thinking is used internally but never requested for display or stored.
      thinking: { type: "adaptive" },
      output_config: {
        effort: request.effort,
        format: { type: "json_schema", schema: request.jsonSchema },
      },
      ...(this.serverSideFallback
        ? { betas: [SERVER_FALLBACK_BETA], fallbacks: "default" as const }
        : {}),
    };
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const params = this.buildParams(request);
    const options = { signal: request.signal, timeout: this.timeoutMs };
    let message: BetaMessage;
    try {
      message =
        request.maxOutputTokens > STREAM_THRESHOLD_TOKENS
          ? await this.client.beta.messages
              .stream(params, options)
              .finalMessage()
          : await this.client.beta.messages.create(params, options);
    } catch (error) {
      throw toProviderError(error);
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    const stop = message.stop_reason as StopReason | null;
    const usage = message.usage;
    return {
      text,
      stopReason: stop && KNOWN_STOPS.has(stop) ? stop : "other",
      modelId: message.model,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      },
      refusalCategory: message.stop_details?.category ?? null,
    };
  }
}

/** Maps SDK errors to provider-neutral kinds. Messages carry only status and class names. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError)
    return new ProviderError("timeout", "LLM request aborted", false);
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError("timeout", "LLM request timed out", true);
  if (error instanceof Anthropic.APIConnectionError)
    return new ProviderError("unavailable", "LLM connection failed", true);
  if (error instanceof Anthropic.AuthenticationError)
    return new ProviderError("auth", "LLM authentication failed", false, 401);
  if (error instanceof Anthropic.PermissionDeniedError)
    return new ProviderError("auth", "LLM permission denied", false, 403);
  if (error instanceof Anthropic.RateLimitError)
    return new ProviderError("rate_limited", "LLM rate limited", true, 429);
  if (error instanceof Anthropic.BadRequestError)
    return new ProviderError(
      "bad_request",
      "LLM rejected the request",
      false,
      400,
    );
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    // 5xx and 529 (overloaded) are transient.
    if (status !== undefined && status >= 500)
      return new ProviderError(
        "unavailable",
        `LLM unavailable (${status})`,
        true,
        status,
      );
    return new ProviderError(
      "unknown",
      `LLM error (${status ?? "no status"})`,
      false,
      status,
    );
  }
  return new ProviderError("unknown", "LLM call failed", false);
}
