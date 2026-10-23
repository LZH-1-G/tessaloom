import { z } from "zod";
import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "../types";
import {
  DEEPSEEK_CNY_PRICES,
  deepseekReservationMicros,
  deepseekUsdPrices,
  type DeepSeekPriceApproval,
} from "./deepseek-pricing";

export const DEEPSEEK_MODELS = ["deepseek-v4-pro", "deepseek-flash"] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelope = z.object({
  model: z.string().min(1),
  status: z.enum(["completed", "incomplete", "failed", "in_progress"]),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      role: z.string().optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    total_tokens: count,
    input_tokens_details: z.object({ cached_tokens: count }),
    output_tokens_details: z.object({ reasoning_tokens: count }),
  }),
});
export interface DeepSeekProviderOptions {
  apiKey: string;
  liveApproved: boolean;
  priceApproval: DeepSeekPriceApproval;
  maxRequests: number;
  /** Native CNY budget, independent of the USD ledger. Initial validation is capped at CNY 2. */
  budgetCny: number;
  maxInputBytes?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}
const localError = (message: string) =>
  new ProviderError("bad_request", message, false, undefined, false);

/** Dedicated supported Responses API, no SDK, tools, implicit retries, or alternate host. */
export class DeepSeekProvider implements LlmProvider {
  readonly name = "deepseek";
  private requests = 0;
  private reservedMicros = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly options: DeepSeekProviderOptions;
  constructor(options: DeepSeekProviderOptions) {
    this.options = { ...options, priceApproval: { ...options.priceApproval } };
    this.now = options.now ?? Date.now;
    deepseekUsdPrices(options.priceApproval, this.now());
    if (
      !options.apiKey ||
      !options.liveApproved ||
      !Number.isSafeInteger(options.maxRequests) ||
      options.maxRequests < 1 ||
      options.maxRequests > 4 ||
      !Number.isFinite(options.budgetCny) ||
      options.budgetCny <= 0 ||
      options.budgetCny > 2
    )
      throw new Error(
        "DeepSeek requires explicit live approval, private key and bounded CNY budget",
      );
    for (const [value, ceiling] of [
      [options.maxInputBytes ?? 16_384, 16_384],
      [options.maxOutputTokens ?? 8_192, 8_192],
      [options.timeoutMs ?? 60_000, 120_000],
    ])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > ceiling!)
        throw new Error("Invalid DeepSeek request limits");
  }
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      deepseekUsdPrices(this.options.priceApproval, this.now());
    } catch {
      throw localError("DeepSeek pricing or currency approval expired");
    }
    if (!(DEEPSEEK_MODELS as readonly string[]).includes(request.model))
      throw localError("Unapproved DeepSeek model");
    if (this.stopped || this.requests >= this.options.maxRequests)
      throw localError("DeepSeek request budget exhausted or latched off");
    if (request.signal?.aborted)
      throw new ProviderError(
        "timeout",
        "DeepSeek request cancelled",
        false,
        undefined,
        false,
      );
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > (this.options.maxOutputTokens ?? 8_192)
    )
      throw localError("DeepSeek output cap exceeded");
    const body = {
      model: request.model,
      instructions:
        request.system +
        "\nReturn only JSON conforming to the supplied schema.",
      input: request.messages.map((m) => ({
        type: "message",
        role: m.role,
        content: m.content,
      })),
      text: {
        format: {
          type: "json_schema",
          name: "tessaloom_output",
          schema: request.jsonSchema,
        },
      },
      reasoning: {
        effort:
          request.effort === "max"
            ? "max"
            : request.effort === "low"
              ? "low"
              : "high",
      },
      max_output_tokens: request.maxOutputTokens,
      stream: false,
    };
    const serialized = JSON.stringify(body);
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > (this.options.maxInputBytes ?? 16_384))
      throw localError("DeepSeek input cap exceeded");
    const reservation = deepseekReservationMicros(
      request.model,
      bytes,
      request.maxOutputTokens,
    );
    if (
      this.reservedMicros + reservation >
      Math.floor(this.options.budgetCny * 1_000_000)
    )
      throw localError("DeepSeek native CNY budget exhausted");
    // No refund/reuse of this native allowance; all dispatched attempts, including failures,
    // retain their bound. Concurrent requests cannot overshoot either local limit.
    this.reservedMicros += reservation;
    this.requests++;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    try {
      const response = await (this.options.fetch ?? fetch)(
        "https://api.deepseek.com/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: serialized,
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        throw new ProviderError(
          status === 401 || status === 403 || status === 402
            ? "auth"
            : status === 429
              ? "rate_limited"
              : status >= 500 || status === 404
                ? "unavailable"
                : "bad_request",
          `DeepSeek request failed (${status})`,
          false,
          status,
        ); // Initial trial never retries availability errors.
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let raw = "";
      let size = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error();
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = envelope.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error();
      const data = parsed.data;
      const u = data.usage;
      if (
        data.model !== request.model ||
        u.input_tokens_details.cached_tokens > u.input_tokens ||
        u.output_tokens_details.reasoning_tokens > u.output_tokens ||
        u.total_tokens !== u.input_tokens + u.output_tokens
      )
        throw new Error();
      const rate = DEEPSEEK_CNY_PRICES[request.model]!;
      const costMicros = Math.ceil(
        (u.input_tokens - u.input_tokens_details.cached_tokens) * rate.input +
          u.input_tokens_details.cached_tokens * rate.cacheRead +
          u.output_tokens * rate.output,
      );
      if (costMicros > reservation) this.stopped = true; // Return known usage for settlement, but prohibit further work.
      const refused =
        data.incomplete_details?.reason === "content_filter" ||
        data.output.some((item) =>
          item.content?.some((p) => p.type === "refusal"),
        );
      const unexpected =
        data.status === "failed" ||
        data.status === "in_progress" ||
        data.output.some(
          (item) => !["message", "reasoning"].includes(item.type),
        );
      if (unexpected) this.stopped = true;
      return {
        text: refused
          ? ""
          : data.output
              .filter(
                (item) => item.type === "message" && item.role === "assistant",
              )
              .flatMap((item) => item.content ?? [])
              .filter((p) => p.type === "output_text")
              .map((p) => p.text ?? "")
              .join(""),
        stopReason: refused
          ? "refusal"
          : data.status === "incomplete" &&
              data.incomplete_details?.reason === "max_output_tokens"
            ? "max_tokens"
            : data.status === "completed" && !unexpected
              ? "end_turn"
              : "other",
        modelId: data.model,
        usage: {
          inputTokens: u.input_tokens - u.input_tokens_details.cached_tokens,
          cachedInputTokens: u.input_tokens_details.cached_tokens,
          cacheWriteTokens: 0,
          outputTokens: u.output_tokens,
          reasoningTokens: u.output_tokens_details.reasoning_tokens,
        },
        refusalCategory: refused ? "provider_safety" : null,
      };
    } catch (error) {
      this.stopped = true; // Unknown outcomes stop the initial trial, including HTTP failures.
      if (error instanceof ProviderError) throw error;
      if (signal.aborted)
        throw new ProviderError(
          "timeout",
          "DeepSeek request cancelled or timed out",
          false,
        );
      throw new ProviderError(
        "unknown",
        "DeepSeek connection, response or usage failed validation",
        false,
      );
    }
  }
}
