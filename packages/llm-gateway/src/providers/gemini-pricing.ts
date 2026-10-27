import type { PriceTable } from "../cost";

/**
 * Paid Tier, Standard service tier, text input (USD per 1M tokens) from
 * https://ai.google.dev/gemini-api/docs/pricing ("Last updated 2026-10-26 UTC"). Output
 * includes thinking tokens; cacheRead is the context-caching (implicit cache hit) rate.
 * No approved model has prompt-length tiers below 200k tokens, and the provider caps inputs
 * at 128 KiB, so the >200k rates never apply. Batch, Flex and Priority are not used.
 */
export const GEMINI_PRICE_REVIEW = "2026-10-26";
/** A paid-tier pricing attestation must be at least this recent. */
export const GEMINI_PRICING_MAX_AGE_MS = 90 * 86_400_000;

type Rate = PriceTable[string];
const flat = (input: number, cacheRead: number, output: number): Rate => ({
  input,
  cacheWrite: input,
  cacheRead,
  output,
});

/** Each entry applies from `from` (UTC, inclusive) until the next entry. */
export const GEMINI_PRICE_SCHEDULE: Readonly<
  Record<string, readonly { from: string; rate: Rate }[]>
> = {
  // Paid only (no free tier); implicit caching only. Announced increase: rates double
  // on 2026-12-01.
  "gemini-4-argon": [
    { from: "2026-01-01", rate: flat(2, 0.1, 10) },
    { from: "2026-12-01", rate: flat(4, 0.2, 20) },
  ],
  "gemini-3.5-flash-lite": [{ from: "2026-01-01", rate: flat(0.3, 0.03, 2.5) }],
  "gemini-3.1-flash-lite": [
    { from: "2026-01-01", rate: flat(0.25, 0.025, 1.5) },
  ],
  // Announced increase: rates double on 2027-01-01.
  "gemini-3.6-flash": [
    { from: "2026-01-01", rate: flat(0.75, 0.075, 3.75) },
    { from: "2027-01-01", rate: flat(1.5, 0.15, 7.5) },
  ],
  "gemini-3.8-flash": [
    { from: "2026-01-01", rate: flat(0.75, 0.075, 3.75) },
    { from: "2027-01-01", rate: flat(1.5, 0.15, 7.5) },
  ],
  // Legacy: Google serves 2.5 only to projects that used it before.
  "gemini-2.5-flash-lite": [{ from: "2026-01-01", rate: flat(0.1, 0.01, 0.4) }],
  "gemini-2.5-flash": [{ from: "2026-01-01", rate: flat(0.3, 0.03, 2.5) }],
};

/** Rates in effect at `now`. A long-lived gateway asks again for every call. */
export function geminiPrices(now = Date.now()): PriceTable {
  const table: Record<string, Rate> = {};
  for (const [model, schedule] of Object.entries(GEMINI_PRICE_SCHEDULE)) {
    const current = schedule
      .filter((entry) => Date.parse(entry.from + "T00:00:00Z") <= now)
      .at(-1);
    if (current) table[model] = current.rate;
  }
  return table;
}

/** Flat-rate models only: safe to price without a clock (the gateway's static default). */
export const GEMINI_FLAT_PRICES: PriceTable = Object.fromEntries(
  Object.entries(GEMINI_PRICE_SCHEDULE)
    .filter(([, schedule]) => schedule.length === 1)
    .map(([model, schedule]) => [model, schedule[0]!.rate]),
);

/**
 * The owner's explicit statement that this code's rates match Google's page for their
 * account. Expires so a price change is never silently carried into paid billing.
 */
export function geminiPricingApproved(verifiedAt: string, now = Date.now()) {
  const reviewed = Date.parse(verifiedAt);
  return (
    Number.isFinite(reviewed) &&
    reviewed <= now &&
    now - reviewed <= GEMINI_PRICING_MAX_AGE_MS &&
    reviewed >= Date.parse(GEMINI_PRICE_REVIEW + "T00:00:00Z")
  );
}
