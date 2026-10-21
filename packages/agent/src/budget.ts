import type { RunBudget, RunUsage } from "@tessaloom/core";

export type BudgetLimit =
  | "maxQlooCalls"
  | "maxLlmCalls"
  | "maxLlmOutputTokens"
  | "maxEstimatedCostUsd"
  | "wallClockSeconds";

export interface Remaining {
  qlooCalls: number;
  llmCalls: number;
  llmOutputTokens: number;
  costUsd: number;
  wallClockSeconds: number;
}

export function remaining(
  budget: RunBudget,
  usage: RunUsage,
  elapsedSeconds: number,
): Remaining {
  return {
    qlooCalls: Math.max(0, budget.maxQlooCalls - usage.qlooCalls),
    llmCalls: Math.max(0, budget.maxLlmCalls - usage.llmCalls),
    llmOutputTokens: Math.max(
      0,
      budget.maxLlmOutputTokens - usage.llmOutputTokens,
    ),
    costUsd: Math.max(0, budget.maxEstimatedCostUsd - usage.estimatedCostUsd),
    wallClockSeconds: Math.max(0, budget.wallClockSeconds - elapsedSeconds),
  };
}

/**
 * The first exhausted limit, or null. LLM and Qloo limits only count as exhausted when the
 * next state actually needs that resource (AGENT_WORKFLOW §7 "budget pre-check").
 */
export function exhaustedLimit(
  budget: RunBudget,
  usage: RunUsage,
  elapsedSeconds: number,
  needs: { llm: boolean; qloo: boolean },
): BudgetLimit | null {
  const r = remaining(budget, usage, elapsedSeconds);
  if (r.wallClockSeconds <= 0) return "wallClockSeconds";
  if (needs.qloo && r.qlooCalls <= 0) return "maxQlooCalls";
  if (needs.llm) {
    if (r.llmCalls <= 0) return "maxLlmCalls";
    if (r.llmOutputTokens <= 0) return "maxLlmOutputTokens";
    if (r.costUsd <= 0) return "maxEstimatedCostUsd";
  }
  return null;
}

export interface UsageDelta {
  qlooCalls?: number;
  llmCalls?: number;
  llmInputTokens?: number;
  llmOutputTokens?: number;
  estimatedCostUsd?: number;
}

export function addUsage(usage: RunUsage, delta: UsageDelta): RunUsage {
  return {
    qlooCalls: usage.qlooCalls + (delta.qlooCalls ?? 0),
    llmCalls: usage.llmCalls + (delta.llmCalls ?? 0),
    llmInputTokens: usage.llmInputTokens + (delta.llmInputTokens ?? 0),
    llmOutputTokens: usage.llmOutputTokens + (delta.llmOutputTokens ?? 0),
    // Fixed precision keeps the stored JSON stable across additions.
    estimatedCostUsd: Number(
      (usage.estimatedCostUsd + (delta.estimatedCostUsd ?? 0)).toFixed(6),
    ),
  };
}
