import {
  recordLlmInvocation,
  reserveLlmSpend,
  settleLlmSpend,
  type DbHandle,
  type Executor,
  type LlmSpendLimits,
} from "@tessaloom/db";
import {
  AnthropicProvider,
  GeminiProvider,
  GEMINI_MODELS,
  DeepSeekProvider,
  DEEPSEEK_MODELS,
  DEEPSEEK_PRICE_REVIEW,
  deepseekUsdPrices,
  type PriceTable,
  LlmGateway,
  type LlmInvocationRecorder,
  type LlmProvider,
  type SpendGuard,
} from "@tessaloom/llm-gateway";
import { createScriptedDemoProvider } from "./scripted-llm";

/**
 * M10-A spend ledger: every provider attempt reserves its upper-bound cost against the global,
 * workspace, experiment, run, and grant caps before the call (fail-closed: a call without a
 * run, or a ledger error, never reaches the provider).
 */
export function createSpendGuard(
  handle: DbHandle,
  limits: LlmSpendLimits,
): SpendGuard {
  return {
    async reserve({ ctx, model, upperBoundUsd, maxOutputTokens }) {
      if (!ctx.runId)
        return {
          ok: false,
          code: "NO_RUN",
          message: "LLM calls are only allowed inside a budgeted run",
        };
      return reserveLlmSpend(handle, {
        runId: ctx.runId,
        model,
        upperBoundUsd,
        maxOutputTokens,
        limits,
      });
    },
    settle: (reservationId, actualUsd) =>
      settleLlmSpend(handle, reservationId, actualUsd),
  };
}

/** Persists each provider call as one `llm_invocations` row (ADR-022: injected recorder). */
export function createDbLlmRecorder(db: Executor): LlmInvocationRecorder {
  return {
    async record(input) {
      const row = await recordLlmInvocation(db, {
        runId: input.ctx.runId ?? null,
        projectId: input.ctx.projectId,
        role: input.role,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        provider: input.provider,
        modelId: input.modelId,
        fallbackUsed: input.fallbackUsed,
        effort: input.effort,
        inputHash: input.inputHash,
        inputExcerpt: input.inputExcerpt,
        output: input.output ?? null,
        validationStatus: input.validationStatus,
        validationErrors: input.validationErrors,
        repairOfId: input.repairOfId,
        stopReason: input.stopReason,
        // Cache writes are billed input; the schema has no separate column for them.
        inputTokens: input.usage.inputTokens + input.usage.cacheWriteTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        outputTokens: input.usage.outputTokens,
        estimatedCostUsd: input.costUsd.toFixed(4),
        latencyMs: input.latencyMs,
      });
      return row.id;
    },
  };
}

export interface LlmSettings {
  LLM_PROVIDER: "anthropic" | "scripted" | "gemini" | "deepseek";
  LLM_MODEL: string;
  LLM_FALLBACK_MODEL: string;
  LLM_MODE: "standard" | "economy";
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_LIVE_APPROVED?: "off" | "on";
  DEEPSEEK_MAX_REQUESTS?: number;
  DEEPSEEK_BUDGET_CNY?: number;
  DEEPSEEK_USD_PER_CNY?: number;
  DEEPSEEK_PRICING_VERIFIED_AT?: string;
  QLOO_MODE?: "live" | "synthetic" | "fixture";
  GEMINI_API_KEY?: string;
  GEMINI_FREE_TIER_CONFIRMED?: "off" | "on";
  GEMINI_DATA_SHARING_APPROVED?: "off" | "on";
  GEMINI_MAX_REQUESTS?: number;
  GEMINI_TIMEOUT_MS?: number;
}

/**
 * Builds the gateway from worker settings. A missing Anthropic key yields `null`: runs that
 * need the LLM then fail with a configuration error instead of the worker crashing.
 */
/** Model ids a scripted deployment reports: never a real model name, always $0. */
export const SCRIPTED_MODELS = {
  primary: "scripted-demo",
  fallback: "scripted-demo-fallback",
} as const;

/** The models a deployment actually uses (scripted runs never borrow a real model name). */
export function effectiveModels(settings: LlmSettings) {
  if (settings.LLM_PROVIDER === "deepseek") {
    const primary =
      settings.LLM_MODE === "economy" ? "deepseek-flash" : "deepseek-v4-pro";
    return { primary, fallback: primary }; // Alternative selected explicitly, never automatic fallback.
  }
  return settings.LLM_PROVIDER === "scripted"
    ? { primary: SCRIPTED_MODELS.primary, fallback: SCRIPTED_MODELS.fallback }
    : {
        primary: settings.LLM_MODEL,
        fallback:
          settings.LLM_PROVIDER === "gemini"
            ? settings.LLM_MODEL
            : settings.LLM_FALLBACK_MODEL,
      };
}

export function createLlmGateway(
  settings: LlmSettings,
  recorder: LlmInvocationRecorder,
  provider?: LlmProvider,
  spendGuard?: SpendGuard,
): LlmGateway | null {
  let resolved = provider;
  let prices: PriceTable | undefined;
  let pricingContext: Record<string, unknown> | undefined;
  let models = {
    primary: settings.LLM_MODEL,
    fallback: settings.LLM_FALLBACK_MODEL,
  };
  if (settings.LLM_PROVIDER === "deepseek") {
    if (
      !settings.DEEPSEEK_API_KEY ||
      settings.DEEPSEEK_LIVE_APPROVED !== "on" ||
      !settings.DEEPSEEK_MAX_REQUESTS ||
      !settings.DEEPSEEK_BUDGET_CNY ||
      !settings.DEEPSEEK_USD_PER_CNY ||
      !settings.DEEPSEEK_PRICING_VERIFIED_AT ||
      !["fixture", "synthetic"].includes(settings.QLOO_MODE ?? "")
    )
      return null;
    const priceApproval = {
      usdPerCny: settings.DEEPSEEK_USD_PER_CNY,
      verifiedAt: settings.DEEPSEEK_PRICING_VERIFIED_AT,
    };
    try {
      prices = deepseekUsdPrices(priceApproval);
    } catch {
      return null;
    }
    pricingContext = {
      billingCurrency: "CNY",
      ledgerCurrency: "USD",
      usdPerCny: priceApproval.usdPerCny,
      pricingVerifiedAt: priceApproval.verifiedAt,
      tariffSourceDate: DEEPSEEK_PRICE_REVIEW,
      tariff: "peak-conservative-estimate",
    };
    models = effectiveModels(settings);
    if (!(DEEPSEEK_MODELS as readonly string[]).includes(models.primary))
      return null;
    resolved ??= new DeepSeekProvider({
      apiKey: settings.DEEPSEEK_API_KEY,
      liveApproved: true,
      priceApproval,
      maxRequests: settings.DEEPSEEK_MAX_REQUESTS,
      budgetCny: settings.DEEPSEEK_BUDGET_CNY,
    });
  }
  if (!resolved) {
    models = effectiveModels(settings);
    // Scripted: deterministic stand-ins (development/CI only; rejected in production).
    if (settings.LLM_PROVIDER === "scripted")
      resolved = createScriptedDemoProvider();
    else if (settings.LLM_PROVIDER === "gemini") {
      if (
        !settings.GEMINI_API_KEY ||
        settings.GEMINI_FREE_TIER_CONFIRMED !== "on" ||
        settings.GEMINI_DATA_SHARING_APPROVED !== "on" ||
        !(GEMINI_MODELS as readonly string[]).includes(settings.LLM_MODEL) ||
        !settings.GEMINI_MAX_REQUESTS
      )
        return null;
      resolved = new GeminiProvider({
        apiKey: settings.GEMINI_API_KEY,
        model: settings.LLM_MODEL,
        freeTierConfirmed: true,
        dataSharingApproved: true,
        maxRequests: settings.GEMINI_MAX_REQUESTS,
        timeoutMs: settings.GEMINI_TIMEOUT_MS,
      });
    } else if (settings.ANTHROPIC_API_KEY)
      resolved = new AnthropicProvider({ apiKey: settings.ANTHROPIC_API_KEY });
    else return null;
  }
  return new LlmGateway({
    provider: resolved,
    primaryModel: models.primary,
    fallbackModel: ["gemini", "deepseek"].includes(settings.LLM_PROVIDER)
      ? null
      : models.fallback,
    prices,
    pricingContext,
    ...(settings.LLM_PROVIDER === "deepseek"
      ? { maxRepairs: 0, retryTruncation: false, maxOutputTokensCeiling: 8192 }
      : {}),
    mode: settings.LLM_MODE,
    recorder,
    allowUnpricedModels: resolved.name === "scripted",
    spendGuard,
  });
}

/** Native trial allowance also clamps persistent M10-A USD scopes; public open access
 * is never sufficient for paid DeepSeek trials. An approved grant remains required. */
export function spendLimitsForProvider(
  settings: LlmSettings,
  limits: LlmSpendLimits,
): LlmSpendLimits {
  if (settings.LLM_PROVIDER !== "deepseek") return limits;
  let cap = 0;
  try {
    if (
      settings.DEEPSEEK_LIVE_APPROVED !== "on" ||
      !settings.DEEPSEEK_USD_PER_CNY ||
      !settings.DEEPSEEK_PRICING_VERIFIED_AT ||
      !settings.DEEPSEEK_BUDGET_CNY ||
      settings.DEEPSEEK_BUDGET_CNY > 2
    )
      throw new Error();
    deepseekUsdPrices({
      usdPerCny: settings.DEEPSEEK_USD_PER_CNY,
      verifiedAt: settings.DEEPSEEK_PRICING_VERIFIED_AT,
    });
    cap = settings.DEEPSEEK_BUDGET_CNY * settings.DEEPSEEK_USD_PER_CNY;
    if (!Number.isFinite(cap) || cap <= 0) throw new Error();
  } catch {
    return {
      ...limits,
      access: "off",
      globalDailyUsd: 0,
      workspaceDailyUsd: 0,
      experimentUsd: 0,
    };
  }
  return {
    access: limits.access === "off" ? "off" : "invite",
    globalDailyUsd: Math.min(limits.globalDailyUsd, cap),
    workspaceDailyUsd: Math.min(limits.workspaceDailyUsd, cap),
    experimentUsd: Math.min(limits.experimentUsd, cap),
  };
}
