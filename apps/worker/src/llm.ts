import { recordLlmInvocation, type Executor } from "@tessaloom/db";
import {
  AnthropicProvider,
  LlmGateway,
  type LlmInvocationRecorder,
  type LlmProvider,
} from "@tessaloom/llm-gateway";
import { createScriptedDemoProvider } from "./scripted-llm";

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
  LLM_PROVIDER: "anthropic" | "scripted";
  LLM_MODEL: string;
  LLM_FALLBACK_MODEL: string;
  LLM_MODE: "standard" | "economy";
  ANTHROPIC_API_KEY?: string;
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
  return settings.LLM_PROVIDER === "scripted"
    ? { primary: SCRIPTED_MODELS.primary, fallback: SCRIPTED_MODELS.fallback }
    : { primary: settings.LLM_MODEL, fallback: settings.LLM_FALLBACK_MODEL };
}

export function createLlmGateway(
  settings: LlmSettings,
  recorder: LlmInvocationRecorder,
  provider?: LlmProvider,
): LlmGateway | null {
  let resolved = provider;
  let models = {
    primary: settings.LLM_MODEL,
    fallback: settings.LLM_FALLBACK_MODEL,
  };
  if (!resolved) {
    models = effectiveModels(settings);
    // Scripted: deterministic stand-ins (development/CI only; rejected in production).
    if (settings.LLM_PROVIDER === "scripted")
      resolved = createScriptedDemoProvider();
    else if (settings.ANTHROPIC_API_KEY)
      resolved = new AnthropicProvider({ apiKey: settings.ANTHROPIC_API_KEY });
    else return null;
  }
  return new LlmGateway({
    provider: resolved,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    mode: settings.LLM_MODE,
    recorder,
    allowUnpricedModels: resolved.name === "scripted",
  });
}
