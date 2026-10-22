import type { ProviderUsage } from "./types";

/**
 * USD per million tokens (ADR-018), from the official pricing page fetched 2026-10-20.
 * Re-verify before judging; update the source date when values change.
 */
export const PRICE_SOURCE_DATE = "2026-10-20";
export const PRICES: Record<
  string,
  { input: number; cacheWrite: number; cacheRead: number; output: number }
> = {
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": {
    input: 2,
    cacheWrite: 2.5,
    cacheRead: 0.1,
    output: 10,
  },
};

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

/** Cost of a completed call. Adaptive-thinking tokens are billed as output tokens. */
export function estimateCostUsd(model: string, usage: ProviderUsage): number {
  const price = PRICES[model];
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
): number {
  const price = PRICES[model];
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
): number {
  const price = PRICES[model];
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
  };
}
