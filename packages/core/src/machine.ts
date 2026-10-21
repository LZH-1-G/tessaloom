import { TERMINAL_RUN_STATES, type RunKind, type RunState } from "./enums";

/**
 * The run state machine (AGENT_WORKFLOW §5.2). It lives in `core` because both the worker
 * (step commits) and the web process (human gates, cancellation) apply transitions, and the
 * web may only import `core` and `db` (ADR-023). `packages/agent` re-exports it.
 */

/** AGENT_WORKFLOW §5.2 events. */
export const RUN_EVENTS = [
  "START",
  "INTENT_READY",
  "USER_CONFIRMED_BRIEF",
  "USER_EDITED_BRIEF",
  "RESOLUTION_AMBIGUOUS",
  "RESOLUTION_COMPLETE",
  "USER_CONFIRMED_ENTITIES",
  "USER_REFINED_TERMS",
  "DISCOVERY_DONE",
  "DISCOVERY_EMPTY",
  "POOL_READY",
  "HYPOTHESES_READY",
  "PLAN_READY",
  "COLLECTION_DONE",
  "REVISE",
  "CONVERGED",
  "REVISION_READY",
  "USER_SELECTED_HYPOTHESES",
  "DELTA_NEEDS_CONFIRMATION",
  "DELTA_AUTO_APPROVED",
  "DELTA_RESCORE_ONLY",
  "USER_CONFIRMED_COUNTERFACTUAL",
  "COMPARISON_READY",
  "BLUEPRINT_DRAFTED",
  "BLUEPRINT_INVALID",
  "BLUEPRINT_VALID",
  "BUDGET_EXHAUSTED",
  "FATAL_ERROR",
  "CANCEL",
  "RETRY",
] as const;
export type RunEventName = (typeof RUN_EVENTS)[number];

/** Facts a guard may inspect. Missing facts make a guard fail closed. */
export interface GuardContext {
  kind?: RunKind;
  intentValid?: boolean;
  confirmedBriefVersionId?: string;
  currentBriefVersionId?: string;
  newBriefVersionExists?: boolean;
  resolutionStatuses?: string[];
  seedDomains?: string[];
  discoveryOkQueries?: number;
  poolSize?: number;
  validHypotheses?: number;
  planWithinBudget?: boolean;
  allQueriesFinal?: boolean;
  terminationMet?: boolean;
  iterationIncremented?: boolean;
  selectionRecorded?: boolean;
  estimatedQlooCalls?: number;
  autoApproveQlooCalls?: number;
  dirtyQueries?: number;
  comparisonCommitted?: boolean;
  blueprintRepairAttempts?: number;
  outputsConsistent?: boolean;
  /** RETRY: the failure was transient and this is the state it failed in. */
  retryableFailure?: boolean;
  retryState?: RunState;
}

export interface Transition {
  from: RunState;
  event: RunEventName;
  to: RunState | ((ctx: GuardContext) => RunState);
  guard?: (ctx: GuardContext) => boolean;
  description: string;
}

const FIRST_STATE: Record<RunKind, RunState> = {
  EXPLORATION: "ANALYZING_INTENT",
  COUNTERFACTUAL: "PLANNING_COUNTERFACTUAL",
  REVALIDATION: "COLLECTING_EVIDENCE",
  COMPOSITION: "COMPOSING_BLUEPRINT",
};

const settled = (statuses: string[] | undefined) =>
  !!statuses &&
  statuses.length > 0 &&
  statuses.every((s) => s === "RESOLVED" || s === "EXCLUDED");

/** The declarative transition table (AGENT_WORKFLOW §5.2). Anything not listed is illegal. */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: "QUEUED",
    event: "START",
    to: (c) => FIRST_STATE[c.kind!],
    guard: (c) => !!c.kind && Object.hasOwn(FIRST_STATE, c.kind),
    description: "run kind is known",
  },
  {
    from: "ANALYZING_INTENT",
    event: "INTENT_READY",
    to: "AWAITING_BRIEF_CONFIRMATION",
    guard: (c) => c.intentValid === true,
    description: "IntentFrame is valid",
  },
  {
    from: "AWAITING_BRIEF_CONFIRMATION",
    event: "USER_CONFIRMED_BRIEF",
    to: "RESOLVING_ENTITIES",
    guard: (c) =>
      !!c.currentBriefVersionId &&
      c.confirmedBriefVersionId === c.currentBriefVersionId,
    description: "confirmation references the current brief version",
  },
  {
    from: "AWAITING_BRIEF_CONFIRMATION",
    event: "USER_EDITED_BRIEF",
    to: "ANALYZING_INTENT",
    guard: (c) => c.newBriefVersionExists === true,
    description: "a new brief version exists",
  },
  {
    from: "RESOLVING_ENTITIES",
    event: "RESOLUTION_AMBIGUOUS",
    to: "AWAITING_ENTITY_CONFIRMATION",
    guard: (c) =>
      !!c.resolutionStatuses?.some(
        (s) => s === "AMBIGUOUS" || s === "UNRESOLVED",
      ),
    description: "≥ 1 interest is AMBIGUOUS or UNRESOLVED",
  },
  {
    from: "RESOLVING_ENTITIES",
    event: "RESOLUTION_COMPLETE",
    to: "DISCOVERING",
    guard: (c) => settled(c.resolutionStatuses),
    description: "every interest is RESOLVED or EXCLUDED",
  },
  {
    from: "AWAITING_ENTITY_CONFIRMATION",
    event: "USER_CONFIRMED_ENTITIES",
    to: "DISCOVERING",
    guard: (c) =>
      (c.seedDomains?.length ?? 0) >= 2 && new Set(c.seedDomains).size >= 2,
    description: "≥ 2 seeds in ≥ 2 distinct domains",
  },
  {
    from: "AWAITING_ENTITY_CONFIRMATION",
    event: "USER_REFINED_TERMS",
    to: "RESOLVING_ENTITIES",
    description: "—",
  },
  {
    from: "DISCOVERING",
    event: "DISCOVERY_DONE",
    to: "BUILDING_COLLISION_POOL",
    guard: (c) => (c.discoveryOkQueries ?? 0) >= 1,
    description: "≥ 1 discovery query returned ok or partial",
  },
  {
    from: "DISCOVERING",
    event: "DISCOVERY_EMPTY",
    to: "FAILED",
    guard: (c) => c.discoveryOkQueries === 0,
    description: "every discovery query returned empty or error",
  },
  {
    from: "BUILDING_COLLISION_POOL",
    event: "POOL_READY",
    to: "GENERATING_HYPOTHESES",
    guard: (c) => (c.poolSize ?? 0) >= 3,
    description: "pool size ≥ 3",
  },
  {
    from: "GENERATING_HYPOTHESES",
    event: "HYPOTHESES_READY",
    to: "PLANNING_EVIDENCE",
    guard: (c) => (c.validHypotheses ?? 0) >= 1,
    description: "≥ 1 valid hypothesis after validation",
  },
  {
    from: "PLANNING_EVIDENCE",
    event: "PLAN_READY",
    to: "COLLECTING_EVIDENCE",
    guard: (c) => c.planWithinBudget === true,
    description: "plan is within the remaining budget",
  },
  {
    from: "COLLECTING_EVIDENCE",
    event: "COLLECTION_DONE",
    to: "EVALUATING_EVIDENCE",
    guard: (c) => c.allQueriesFinal === true,
    description: "every planned query reached a final outcome",
  },
  {
    from: "EVALUATING_EVIDENCE",
    event: "REVISE",
    to: "REVISING_HYPOTHESES",
    guard: (c) => c.terminationMet === false,
    description: "termination criteria not met (includes iteration < max)",
  },
  {
    from: "EVALUATING_EVIDENCE",
    event: "CONVERGED",
    to: (c) =>
      c.kind === "EXPLORATION" ? "AWAITING_HYPOTHESIS_SELECTION" : "COMPARING",
    guard: (c) => c.terminationMet === true && !!c.kind,
    description: "termination criteria met",
  },
  {
    from: "REVISING_HYPOTHESES",
    event: "REVISION_READY",
    to: "PLANNING_EVIDENCE",
    guard: (c) => c.iterationIncremented === true,
    description: "iteration incremented",
  },
  {
    from: "AWAITING_HYPOTHESIS_SELECTION",
    event: "USER_SELECTED_HYPOTHESES",
    to: "COMPLETED",
    guard: (c) => c.selectionRecorded === true,
    description: "selection recorded (0–3 hypotheses)",
  },
  {
    from: "PLANNING_COUNTERFACTUAL",
    event: "DELTA_NEEDS_CONFIRMATION",
    to: "AWAITING_COUNTERFACTUAL_CONFIRMATION",
    guard: (c) =>
      (c.estimatedQlooCalls ?? 0) > (c.autoApproveQlooCalls ?? 6) &&
      (c.dirtyQueries ?? 0) > 0,
    description: "estimated Qloo calls > autoApproveQlooCalls",
  },
  {
    from: "PLANNING_COUNTERFACTUAL",
    event: "DELTA_AUTO_APPROVED",
    to: "COLLECTING_EVIDENCE",
    guard: (c) =>
      (c.dirtyQueries ?? 0) > 0 &&
      (c.estimatedQlooCalls ?? Infinity) <= (c.autoApproveQlooCalls ?? 6),
    description: "dirty queries within the auto-approve threshold",
  },
  {
    from: "PLANNING_COUNTERFACTUAL",
    event: "DELTA_RESCORE_ONLY",
    to: "COMPARING",
    guard: (c) => c.dirtyQueries === 0,
    description: "the dirty query set is empty",
  },
  {
    from: "AWAITING_COUNTERFACTUAL_CONFIRMATION",
    event: "USER_CONFIRMED_COUNTERFACTUAL",
    to: "COLLECTING_EVIDENCE",
    description: "user approved the cost preview",
  },
  {
    from: "COMPARING",
    event: "COMPARISON_READY",
    to: "COMPLETED",
    guard: (c) => c.comparisonCommitted === true,
    description: "the comparison row is committed",
  },
  {
    from: "COMPOSING_BLUEPRINT",
    event: "BLUEPRINT_DRAFTED",
    to: "VALIDATING_BLUEPRINT",
    description: "draft produced",
  },
  {
    from: "VALIDATING_BLUEPRINT",
    event: "BLUEPRINT_INVALID",
    to: "COMPOSING_BLUEPRINT",
    guard: (c) => (c.blueprintRepairAttempts ?? Infinity) < 1,
    description: "repairAttempts < 1",
  },
  {
    from: "VALIDATING_BLUEPRINT",
    event: "BLUEPRINT_VALID",
    to: "COMPLETED",
    description: "blueprint passes traceability validation",
  },
];

/** Events accepted from every non-terminal state. */
const GLOBAL: Partial<
  Record<
    RunEventName,
    { to: RunState; guard?: (c: GuardContext) => boolean; description: string }
  >
> = {
  BUDGET_EXHAUSTED: {
    to: "COMPLETED_WITH_LIMITS",
    guard: (c) => c.outputsConsistent !== false,
    description: "the outputs committed so far are self-consistent",
  },
  FATAL_ERROR: { to: "FAILED", description: "—" },
  CANCEL: { to: "CANCELLED", description: "—" },
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: RunState,
    readonly event: RunEventName,
    readonly reason: "NOT_IN_TABLE" | "GUARD_FAILED" | "TERMINAL",
  ) {
    super(`Illegal transition ${from} --${event}--> (${reason})`);
  }
}

export const isTerminal = (state: RunState) =>
  TERMINAL_RUN_STATES.includes(state);
export const isPaused = (state: RunState) => state.startsWith("AWAITING_");

/** States a worker job executes (everything except paused and terminal states). */
export const isRunnable = (state: RunState) =>
  !isTerminal(state) && !isPaused(state);

/** Resolve the next state or throw `IllegalTransition`. */
export function nextState(
  from: RunState,
  event: RunEventName,
  ctx: GuardContext = {},
): RunState {
  // The only way out of a terminal state: the UI's "Retry step" after a transient failure
  // (UI_UX_SPEC §6) re-enters the failed state from the last committed version.
  if (event === "RETRY") {
    if (from !== "FAILED")
      throw new IllegalTransition(from, event, "NOT_IN_TABLE");
    if (
      ctx.retryableFailure !== true ||
      !ctx.retryState ||
      !isRunnable(ctx.retryState)
    )
      throw new IllegalTransition(from, event, "GUARD_FAILED");
    return ctx.retryState;
  }
  if (isTerminal(from)) throw new IllegalTransition(from, event, "TERMINAL");
  const global = GLOBAL[event];
  if (global) {
    if (global.guard && !global.guard(ctx))
      throw new IllegalTransition(from, event, "GUARD_FAILED");
    return global.to;
  }
  const entry = TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (!entry) throw new IllegalTransition(from, event, "NOT_IN_TABLE");
  if (entry.guard && !entry.guard(ctx))
    throw new IllegalTransition(from, event, "GUARD_FAILED");
  return typeof entry.to === "function" ? entry.to(ctx) : entry.to;
}

/** True when the pair exists in the table (ignoring guards). */
export function isDeclared(from: RunState, event: RunEventName): boolean {
  if (event === "RETRY") return from === "FAILED";
  if (isTerminal(from)) return false;
  return (
    Object.hasOwn(GLOBAL, event) ||
    TRANSITIONS.some((t) => t.from === from && t.event === event)
  );
}
