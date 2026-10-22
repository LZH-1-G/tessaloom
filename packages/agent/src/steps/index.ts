import type { RunState } from "@tessaloom/core";
import { Cancelled, base, fatal } from "./common";
import { compareStep, planCounterfactualStep } from "./counterfactual";
import { buildPool, discover } from "./discovery";
import { analyzeIntent } from "./intent";
import {
  collect,
  evaluate,
  generateHypotheses,
  planStep,
  revise,
} from "./loop";
import { resolveEntities } from "./resolution";
import type { Ports, StepContext, StepResult } from "./types";

export * from "./types";
export { domainFromType } from "./common";
export { exactSingle, mergeCandidates } from "./resolution";
export { THREAD_K, MAX_TAG_ENRICHMENT } from "./discovery";
export { effectiveBrief, scoreHypotheses } from "./loop";

/** Execute the handler for the run's current state. Never writes to the database. */
export async function executeStep(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  try {
    switch (ctx.run.state) {
      case "QUEUED":
        return { ...base("START", { kind: ctx.run.kind }) };
      case "ANALYZING_INTENT":
        return await analyzeIntent(ctx, ports);
      case "RESOLVING_ENTITIES":
        return await resolveEntities(ctx, ports);
      case "DISCOVERING":
        return await discover(ctx, ports);
      case "BUILDING_COLLISION_POOL":
        return buildPool(ctx);
      case "GENERATING_HYPOTHESES":
        return await generateHypotheses(ctx, ports);
      case "PLANNING_EVIDENCE":
        return planStep(ctx);
      case "COLLECTING_EVIDENCE":
        return await collect(ctx, ports);
      case "EVALUATING_EVIDENCE":
        return await evaluate(ctx, ports);
      case "REVISING_HYPOTHESES":
        return await revise(ctx, ports);
      case "PLANNING_COUNTERFACTUAL":
        return planCounterfactualStep(ctx);
      case "COMPARING":
        return await compareStep(ctx, ports);
      default:
        // COMPOSITION and REVALIDATION handlers arrive with M9.
        return fatal(
          "STATE_NOT_IMPLEMENTED",
          `No handler for ${ctx.run.state}`,
        );
    }
  } catch (error) {
    if (error instanceof Cancelled)
      return { ...base("CANCEL"), terminalReason: "USER_CANCELLED" };
    throw error;
  }
}

/** Which resources a state consumes (runner budget pre-check, AGENT_WORKFLOW §7). */
export function stateNeeds(state: RunState): { llm: boolean; qloo: boolean } {
  return {
    llm: [
      "ANALYZING_INTENT",
      "GENERATING_HYPOTHESES",
      "EVALUATING_EVIDENCE",
      "REVISING_HYPOTHESES",
      "COMPARING",
    ].includes(state),
    qloo: ["RESOLVING_ENTITIES", "DISCOVERING"].includes(state),
  };
}
