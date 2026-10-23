import type { ProviderUsage } from "./types";

/**
 * USD per million tokens (ADR-018), from the official pricing page fetched 2026-10-20.
 * Re-verify before judging; update the source date when values change.
 */
export const PRICE_SOURCE_DATE = "2026-10-20";
export type PriceTable = Readonly<
  Record<
    string,
    { input: number; cacheWrite: number; cacheRead: number; output: number }
  >
>;
export const PRICES: PriceTable = {
  // Google standard text rates checked 2026-10-23. Used for conservative reservations
  // even on an owner-confirmed Free project; never a reason to enable paid API access.
  "gemini-3.5-flash-lite": {
    input: 0.3,
    cacheWrite: 0.3,
    cacheRead: 0.03,
    output: 2.5,
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
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": {
    input: 2,
    cacheWrite: 2.5,
    cacheRead: 0.1,
    output: 10,
  },
};

export function hasPrice(model: string, prices: PriceTable = PRICES): boolean {
  return Object.hasOwn(prices, model);
}

/** Cost of a completed call. Adaptive-thinking tokens are billed as output tokens. */
export function estimateCostUsd(
  model: string,
  usage: ProviderUsage,
  prices: PriceTable = PRICES,
): number {
  const price = prices[model];
  if (!price) return 0; // scripted/test models are free; unknown live models are rejected earlier
  return (
    (usage.inputTokens * price.input +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cachedInputTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** Rough token estimate for budgeting before a call (about 3.5 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Worst-case cost of one call: all prompt tokens uncached plus the full output cap. */
export function worstCaseCostUsd(
  model: string,
  promptChars: number,
  maxOutputTokens: number,
  prices: PriceTable = PRICES,
): number {
  const price = prices[model];
  if (!price) return 0;
  return (
    (Math.ceil(promptChars / 3.5) * price.input +
      maxOutputTokens * price.output) /
    1_000_000
  );
}

/**
 * Conservative reservation: every prompt byte, plus protocol/schema overhead, at the
 * highest input/cache rate, plus the full output cap (including thinking). This is a local
 * bound, not a provider billing guarantee; a billing overrun latches paid work off.
 */
export function upperBoundCostUsd(
  model: string,
  promptBytes: number,
  maxOutputTokens: number,
  prices: PriceTable = PRICES,
): number {
  const price = prices[model];
  if (!price) return 0;
  return (
    ((promptBytes + 4096) *
      Math.max(price.input, price.cacheWrite, price.cacheRead) +
      maxOutputTokens * price.output) /
    1_000_000
  );
}

export const emptyUsage = (): ProviderUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

export function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
  };
}
