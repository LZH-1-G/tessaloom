import { z } from "zod";
import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "../types";
import { GEMINI_PRICE_SCHEDULE, geminiPricingApproved } from "./gemini-pricing";

// Stable text models with structured output, from the official models page (updated
// 2026-10-22). NOT evidence of access in a particular account; previews are excluded
// because Google shuts them down. No automatic model selection.
export const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  // Legacy: served only to projects that used them before.
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
] as const satisfies readonly (keyof typeof GEMINI_PRICE_SCHEDULE)[];
/** Free tier: per worker lifetime. Paid tier: per UTC day, per worker process. */
export const GEMINI_FREE_MAX_REQUESTS = 50;
export const GEMINI_PAID_MAX_REQUESTS = 5000;
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const responseSchema = z.object({
  modelVersion: z.string().min(1).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
                thought: z.boolean().optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .max(1)
    .optional(),
  usageMetadata: z.object({
    promptTokenCount: count,
    cachedContentTokenCount: count.optional(),
    candidatesTokenCount: count.optional(),
    toolUsePromptTokenCount: count.optional(),
    thoughtsTokenCount: count.optional(),
    totalTokenCount: count,
    serviceTier: z.string().optional(),
  }),
});

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** Owner confirms the key's project is Free, with billing disabled and nonzero quota. */
  freeTierConfirmed?: boolean;
  /** Owner confirms permission for minimized inputs under Google's unpaid-service terms. */
  dataSharingApproved?: boolean;
  /**
   * Owner explicitly approves Paid Tier billing for this key's project. Exclusive with
   * `freeTierConfirmed`; requires a current `pricingVerifiedAt`.
   */
  paidTierApproved?: boolean;
  /** When the owner last checked the price table against Google's page (ISO 8601). */
  pricingVerifiedAt?: string;
  /** Paid tier only: permission to send live, Qloo-derived inputs has been verified. */
  liveInputsApproved?: boolean;
  /**
   * Hard cap across concurrent calls, repairs included: for the worker lifetime on the free
   * tier, and per UTC day on the paid tier.
   */
  maxRequests: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const localError = (message: string) =>
  new ProviderError("bad_request", message, false, undefined, false);

const GEMINI_STRING_FORMATS = new Set(["date-time", "date", "time"]);

/**
 * Gemini-safe copy of a structured-output schema. Google documents neither `$defs`/`$ref`
 * nor formats beyond date-time/date/time, so local definitions are inlined (a cycle fails
 * closed before sending) and other formats move into the description, like the strict
 * transform does for other constraints. The gateway's Zod parse still enforces them all.
 */
export function geminiResponseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const visit = (node: unknown, seen: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item, seen));
    if (!node || typeof node !== "object") return node;
    const { $ref, ...rest } = node as Record<string, unknown>;
    delete rest.$defs; // inlined below; never sent
    if ($ref !== undefined) {
      const name =
        typeof $ref === "string" && $ref.startsWith("#/$defs/")
          ? $ref.slice("#/$defs/".length)
          : null;
      if (!name || !Object.hasOwn(defs, name) || seen.includes(name))
        throw localError("Unsupported Gemini response schema reference");
      return visit({ ...(defs[name] as object), ...rest }, [...seen, name]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest))
      out[key] =
        key === "properties" && value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([name, child]) => [
                name,
                visit(child, seen),
              ]),
            )
          : visit(value, seen);
    if (
      typeof out.format === "string" &&
      !GEMINI_STRING_FORMATS.has(out.format)
    ) {
      const note = `{format: ${JSON.stringify(out.format)}}`;
      out.description =
        typeof out.description === "string"
          ? `${out.description} ${note}`
          : note;
      delete out.format;
    }
    return out;
  };
  return visit(schema, []) as Record<string, unknown>;
}

function assertModel(model: string) {
  if (!(GEMINI_MODELS as readonly string[]).includes(model))
    throw new ProviderError(
      "bad_request",
      "Gemini model is not approved",
      false,
    );
}

function httpError(status: number): ProviderError {
  const kind =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate_limited"
        : status === 404 || status >= 500
          ? "unavailable"
          : "bad_request";
  return new ProviderError(
    kind,
    `Gemini request failed (${status})`,
    status === 429 || status >= 500,
    status,
  );
}

/** Supported Google REST API. Fixed host, key in header, no redirects, SDK retries or tools. */
async function requestJson(options: {
  apiKey: string;
  model: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  fetch: typeof fetch;
}): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    signal.throwIfAborted();
    const response = await options.fetch(
      API + options.model + (options.body ? ":generateContent" : ""),
      {
        method: options.body ? "POST" : "GET",
        headers: {
          "x-goog-api-key": options.apiKey,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    // Bound response memory; never log/persist the provider envelope or its error body.
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted)
      throw new ProviderError(
        "timeout",
        "Gemini request cancelled or timed out",
        !options.signal?.aborted,
      );
    throw new ProviderError(
      "unavailable",
      "Gemini connection or response failed",
      false,
    );
  }
}

/** One read-only metadata request. Does NOT verify billing, quota or successful generation. */
export async function checkGeminiModel(options: {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  assertModel(options.model);
  const raw = await requestJson({
    ...options,
    timeoutMs: 15_000,
    fetch: options.fetch ?? fetch,
  });
  const metadata = z
    .object({
      name: z.string(),
      supportedGenerationMethods: z.array(z.string()),
      inputTokenLimit: count,
      outputTokenLimit: count,
    })
    .safeParse(raw);
  if (
    !metadata.success ||
    metadata.data.name !== `models/${options.model}` ||
    !metadata.data.supportedGenerationMethods.includes("generateContent")
  )
    throw new ProviderError(
      "unavailable",
      "Gemini model does not support generation",
      false,
    );
  return {
    model: options.model,
    inputTokenLimit: metadata.data.inputTokenLimit,
    outputTokenLimit: metadata.data.outputTokenLimit,
    billingVerified: false as const,
    quotaVerified: false as const,
  };
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly billing?: "confirmed-free-tier";
  readonly liveInputsApproved: boolean;
  private requests = 0;
  private capDay: string | null = null;
  private stopped = false;
  private readonly paid: boolean;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: GeminiProviderOptions) {
    assertModel(options.model);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.paid = options.paidTierApproved === true;
    const free = options.freeTierConfirmed === true;
    if (
      !options.apiKey ||
      this.paid === free ||
      (free &&
        (!options.dataSharingApproved ||
          options.liveInputsApproved ||
          options.maxRequests > GEMINI_FREE_MAX_REQUESTS)) ||
      (this.paid &&
        !geminiPricingApproved(options.pricingVerifiedAt ?? "", this.now())) ||
      !Number.isSafeInteger(options.maxRequests) ||
      options.maxRequests < 1 ||
      options.maxRequests > GEMINI_PAID_MAX_REQUESTS ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new Error(
        "Gemini requires private credentials, exactly one confirmed billing tier (free with data-sharing confirmation, or paid with a current pricing review), and a bounded request budget",
      );
    if (free) this.billing = "confirmed-free-tier";
    this.liveInputsApproved = this.paid && options.liveInputsApproved === true;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.model !== this.options.model)
      throw new ProviderError(
        "bad_request",
        "Gemini fallback is disabled",
        false,
        undefined,
        false,
      );
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 32_000
    )
      throw new ProviderError(
        "bad_request",
        "Invalid Gemini output limit",
        false,
        undefined,
        false,
      );
    if (request.signal?.aborted)
      throw new ProviderError(
        "timeout",
        "Gemini request cancelled",
        false,
        undefined,
        false,
      );
    if (
      this.paid &&
      !geminiPricingApproved(this.options.pricingVerifiedAt ?? "", this.now())
    )
      throw localError("Gemini pricing review expired; paid calls are paused");
    if (this.stopped)
      throw localError(
        "Gemini paid calls latched off after an accounting fault",
      );
    // The paid cap is a daily circuit breaker; the free cap never resets in-process.
    const day = this.paid
      ? new Date(this.now()).toISOString().slice(0, 10)
      : null;
    if (day !== this.capDay) {
      this.capDay = day;
      this.requests = 0;
    }
    if (this.requests >= this.options.maxRequests)
      throw new ProviderError(
        "rate_limited",
        "Gemini local request cap reached",
        false,
        undefined,
        false,
      );
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      // Only fields every approved model accepts. Gemini 3+ does not support candidateCount
      // or sampling parameters, and 3.8 Flash rejects thinkingLevel "minimal", so each model
      // keeps its documented default thinking level (3.8 Flash: medium). Thought text is
      // never requested; thinking tokens count toward maxOutputTokens and are billed.
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema: geminiResponseSchema(request.jsonSchema),
      },
    };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 128 * 1024)
      throw new ProviderError(
        "bad_request",
        "Gemini input exceeds local size limit",
        false,
        undefined,
        false,
      );
    this.requests += 1; // Before the first await: concurrent calls cannot overshoot the cap.
    const parsed = responseSchema.safeParse(
      await requestJson({
        apiKey: this.options.apiKey,
        model: request.model,
        body,
        timeoutMs: this.timeoutMs,
        signal: request.signal,
        fetch: this.options.fetch ?? fetch,
      }),
    );
    if (!parsed.success) {
      if (this.paid) this.stopped = true;
      throw new ProviderError(
        "unknown",
        "Gemini response or usage is invalid",
        false,
      );
    }
    const message = parsed.data;
    const candidate = message.candidates?.[0];
    const stop = candidate?.finishReason;
    const blocked =
      !!message.promptFeedback?.blockReason ||
      [
        "SAFETY",
        "RECITATION",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
      ].includes(stop ?? "");
    const usage = message.usageMetadata;
    const cached = usage.cachedContentTokenCount ?? 0;
    const toolPrompt = usage.toolUsePromptTokenCount ?? 0;
    const thoughts = usage.thoughtsTokenCount ?? 0;
    const output = (usage.candidatesTokenCount ?? 0) + thoughts;
    const tier = usage.serviceTier?.toLowerCase().replace(/^service_tier_/, "");
    if (
      cached > usage.promptTokenCount ||
      usage.totalTokenCount !== usage.promptTokenCount + toolPrompt + output ||
      (tier !== undefined && tier !== "standard" && tier !== "unspecified") ||
      (!blocked &&
        (usage.candidatesTokenCount === undefined || !message.modelVersion))
    ) {
      // Unknown billing: the gateway keeps the full reservation; stop further paid work.
      if (this.paid) this.stopped = true;
      throw new ProviderError(
        "unknown",
        "Gemini usage is incomplete or inconsistent",
        false,
      );
    }
    // The gateway rejects an unexpected serving model and keeps the reservation.
    if (
      this.paid &&
      message.modelVersion &&
      message.modelVersion !== request.model
    )
      this.stopped = true;
    return {
      text: blocked
        ? ""
        : (candidate?.content?.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? "")
            .join(""),
      stopReason: blocked
        ? "refusal"
        : stop === "MAX_TOKENS"
          ? "max_tokens"
          : stop === "STOP"
            ? "end_turn"
            : "other",
      modelId: message.modelVersion ?? request.model,
      usage: {
        // Tool-use prompt tokens are billed as input (none are expected: no tools are sent).
        inputTokens: usage.promptTokenCount - cached + toolPrompt,
        cachedInputTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: output,
        reasoningTokens: thoughts,
      },
      refusalCategory: blocked ? "provider_safety" : null,
    };
  }
}
