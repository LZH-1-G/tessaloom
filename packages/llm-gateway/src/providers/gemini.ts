import { z } from "zod";
import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "../types";

// Public free-tier candidates, NOT evidence of access in a particular account.
// Official pricing/models pages reviewed 2026-10-23. No automatic model selection.
export const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
] as const;
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
    thoughtsTokenCount: count.optional(),
    totalTokenCount: count,
  }),
});

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** Owner confirms the key's project is Free, with billing disabled and nonzero quota. */
  freeTierConfirmed: boolean;
  /** Owner confirms permission for minimized inputs under Google's unpaid-service terms. */
  dataSharingApproved: boolean;
  /** Hard cap across concurrent calls, repairs included, for this worker lifetime. */
  maxRequests: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
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
  readonly billing = "confirmed-free-tier" as const;
  private requests = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: GeminiProviderOptions) {
    assertModel(options.model);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !options.apiKey ||
      !options.freeTierConfirmed ||
      !options.dataSharingApproved ||
      !Number.isSafeInteger(options.maxRequests) ||
      options.maxRequests < 1 ||
      options.maxRequests > 50 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new Error(
        "Gemini requires private credentials, free-tier and data-sharing confirmation, and a bounded request budget",
      );
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
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema: request.jsonSchema,
        // No chain-of-thought requested. Thinking usage, when returned, is still accounted.
        thinkingConfig: { includeThoughts: false },
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
    if (!parsed.success)
      throw new ProviderError(
        "unknown",
        "Gemini response or usage is invalid",
        false,
      );
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
    const output =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    if (
      cached > usage.promptTokenCount ||
      usage.totalTokenCount !== usage.promptTokenCount + output ||
      (!blocked &&
        (usage.candidatesTokenCount === undefined || !message.modelVersion))
    )
      throw new ProviderError(
        "unknown",
        "Gemini usage is incomplete or inconsistent",
        false,
      );
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
        inputTokens: usage.promptTokenCount - cached,
        cachedInputTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: output,
      },
      refusalCategory: blocked ? "provider_safety" : null,
    };
  }
}
