import { type PriceTable, upperBoundCostUsd } from "../cost";

/** Official CNY peak tariff reviewed 2026-10-23; no implied conversion from USD tariff. */
export const DEEPSEEK_PRICE_REVIEW = "2026-10-23";
export const DEEPSEEK_CNY_PRICES: PriceTable = {
  "deepseek-v4-pro": { input: 9, cacheWrite: 9, cacheRead: 0.3, output: 27 },
  "deepseek-flash": { input: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 },
};
export interface DeepSeekPriceApproval {
  usdPerCny: number;
  /** Explicit review of both the CNY tariff and conservative FX rate; expires in 24h. */
  verifiedAt: string;
}
export function deepseekUsdPrices(
  approval: DeepSeekPriceApproval,
  now = Date.now(),
): PriceTable {
  const reviewed = Date.parse(approval.verifiedAt);
  if (
    !Number.isFinite(approval.usdPerCny) ||
    approval.usdPerCny <= 0 ||
    approval.usdPerCny > 1 ||
    !Number.isFinite(reviewed) ||
    reviewed > now ||
    now - reviewed > 86_400_000 ||
    reviewed < Date.parse(DEEPSEEK_PRICE_REVIEW + "T00:00:00Z")
  )
    throw new Error(
      "DeepSeek pricing and conservative CNY/USD conversion require a current explicit review",
    );
  return Object.fromEntries(
    Object.entries(DEEPSEEK_CNY_PRICES).map(([model, rate]) => [
      model,
      Object.fromEntries(
        Object.entries(rate).map(([key, value]) => [
          key,
          value * approval.usdPerCny,
        ]),
      ) as PriceTable[string],
    ]),
  );
}
/** Micro-CNY rounded up; a conservative reservation estimate, not a provider billing guarantee. */
export function deepseekReservationMicros(
  model: string,
  promptBytes: number,
  outputTokens: number,
) {
  if (!Object.hasOwn(DEEPSEEK_CNY_PRICES, model))
    throw new Error("Unapproved DeepSeek model");
  return Math.ceil(
    upperBoundCostUsd(model, promptBytes, outputTokens, DEEPSEEK_CNY_PRICES) *
      1_000_000,
  );
}
