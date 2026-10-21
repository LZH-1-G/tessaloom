import { describe, expect, it } from "vitest";
import {
  IllegalTransition,
  RUN_EVENTS,
  RunState,
  TERMINAL_RUN_STATES,
  TRANSITIONS,
  isDeclared,
  isPaused,
  isRunnable,
  nextState,
  type GuardContext,
  type RunEventName,
  type RunKind,
} from "../../packages/core/src";

/** Facts that satisfy each event's guard (TEST_PLAN §4 item 2: "true" side). */
const PASS: Record<RunEventName, GuardContext> = {
  START: { kind: "EXPLORATION" },
  INTENT_READY: { intentValid: true },
  USER_CONFIRMED_BRIEF: {
    confirmedBriefVersionId: "b1",
    currentBriefVersionId: "b1",
  },
  USER_EDITED_BRIEF: { newBriefVersionExists: true },
  RESOLUTION_AMBIGUOUS: { resolutionStatuses: ["RESOLVED", "AMBIGUOUS"] },
  RESOLUTION_COMPLETE: { resolutionStatuses: ["RESOLVED", "EXCLUDED"] },
  USER_CONFIRMED_ENTITIES: { seedDomains: ["movie", "artist"] },
  USER_REFINED_TERMS: {},
  DISCOVERY_DONE: { discoveryOkQueries: 1 },
  DISCOVERY_EMPTY: { discoveryOkQueries: 0 },
  POOL_READY: { poolSize: 3 },
  HYPOTHESES_READY: { validHypotheses: 1 },
  PLAN_READY: { planWithinBudget: true },
  COLLECTION_DONE: { allQueriesFinal: true },
  REVISE: { terminationMet: false },
  CONVERGED: { terminationMet: true, kind: "EXPLORATION" },
  REVISION_READY: { iterationIncremented: true },
  USER_SELECTED_HYPOTHESES: { selectionRecorded: true },
  DELTA_NEEDS_CONFIRMATION: {
    estimatedQlooCalls: 7,
    autoApproveQlooCalls: 6,
    dirtyQueries: 7,
  },
  DELTA_AUTO_APPROVED: {
    estimatedQlooCalls: 6,
    autoApproveQlooCalls: 6,
    dirtyQueries: 6,
  },
  DELTA_RESCORE_ONLY: { dirtyQueries: 0 },
  USER_CONFIRMED_COUNTERFACTUAL: {},
  COMPARISON_READY: { comparisonCommitted: true },
  BLUEPRINT_DRAFTED: {},
  BLUEPRINT_INVALID: { blueprintRepairAttempts: 0 },
  BLUEPRINT_VALID: {},
  BUDGET_EXHAUSTED: { outputsConsistent: true },
  FATAL_ERROR: {},
  CANCEL: {},
  RETRY: { retryableFailure: true, retryState: "COLLECTING_EVIDENCE" },
};

/** Facts that violate each guarded event ("false" side). */
const FAIL: Partial<Record<RunEventName, GuardContext>> = {
  START: {},
  INTENT_READY: { intentValid: false },
  USER_CONFIRMED_BRIEF: {
    confirmedBriefVersionId: "old",
    currentBriefVersionId: "b1",
  },
  USER_EDITED_BRIEF: { newBriefVersionExists: false },
  RESOLUTION_AMBIGUOUS: { resolutionStatuses: ["RESOLVED", "EXCLUDED"] },
  RESOLUTION_COMPLETE: { resolutionStatuses: ["RESOLVED", "AMBIGUOUS"] },
  USER_CONFIRMED_ENTITIES: { seedDomains: ["movie", "movie"] },
  DISCOVERY_DONE: { discoveryOkQueries: 0 },
  DISCOVERY_EMPTY: { discoveryOkQueries: 2 },
  POOL_READY: { poolSize: 2 },
  HYPOTHESES_READY: { validHypotheses: 0 },
  PLAN_READY: { planWithinBudget: false },
  COLLECTION_DONE: { allQueriesFinal: false },
  REVISE: { terminationMet: true },
  CONVERGED: { terminationMet: false, kind: "EXPLORATION" },
  REVISION_READY: { iterationIncremented: false },
  USER_SELECTED_HYPOTHESES: { selectionRecorded: false },
  DELTA_NEEDS_CONFIRMATION: {
    estimatedQlooCalls: 6,
    autoApproveQlooCalls: 6,
    dirtyQueries: 6,
  },
  DELTA_AUTO_APPROVED: {
    estimatedQlooCalls: 7,
    autoApproveQlooCalls: 6,
    dirtyQueries: 7,
  },
  DELTA_RESCORE_ONLY: { dirtyQueries: 2 },
  COMPARISON_READY: { comparisonCommitted: false },
  BLUEPRINT_INVALID: { blueprintRepairAttempts: 1 },
  BUDGET_EXHAUSTED: { outputsConsistent: false },
  RETRY: { retryableFailure: false, retryState: "COLLECTING_EVIDENCE" },
};

const GLOBAL: RunEventName[] = ["BUDGET_EXHAUSTED", "FATAL_ERROR", "CANCEL"];
const STATES = RunState.options;
const NON_TERMINAL = STATES.filter((s) => !TERMINAL_RUN_STATES.includes(s));

describe("transition table (TEST_PLAN §4 item 1)", () => {
  it("covers every (state, event) pair: declared pairs reach the declared state, others throw", () => {
    let declared = 0;
    let illegal = 0;
    for (const from of STATES)
      for (const event of RUN_EVENTS) {
        const entry = TRANSITIONS.find(
          (t) => t.from === from && t.event === event,
        );
        if (isDeclared(from, event)) {
          declared++;
          const to = nextState(from, event, PASS[event]);
          if (entry)
            expect(to).toBe(
              typeof entry.to === "function" ? entry.to(PASS[event]) : entry.to,
            );
          expect(STATES).toContain(to);
        } else {
          illegal++;
          expect(
            () => nextState(from, event, PASS[event]),
            `${from} ${event}`,
          ).toThrow(IllegalTransition);
        }
      }
    expect(declared + illegal).toBe(STATES.length * RUN_EVENTS.length);
    // Every table entry is a declared pair, and no entry starts from a terminal state.
    for (const t of TRANSITIONS) {
      expect(isDeclared(t.from, t.event)).toBe(true);
      expect(TERMINAL_RUN_STATES).not.toContain(t.from);
    }
  });

  it("reports why a transition is illegal", () => {
    expect(() => nextState("QUEUED", "POOL_READY")).toThrow(
      expect.objectContaining({ reason: "NOT_IN_TABLE" }),
    );
    expect(() => nextState("COMPLETED", "CANCEL")).toThrow(
      expect.objectContaining({ reason: "TERMINAL" }),
    );
    expect(() =>
      nextState("BUILDING_COLLISION_POOL", "POOL_READY", { poolSize: 1 }),
    ).toThrow(expect.objectContaining({ reason: "GUARD_FAILED" }));
  });
});

describe("guards (TEST_PLAN §4 item 2)", () => {
  for (const t of TRANSITIONS.filter((x) => x.guard))
    it(`${t.from} --${t.event}--> guard: ${t.description}`, () => {
      expect(t.guard!(PASS[t.event])).toBe(true);
      expect(t.guard!(FAIL[t.event] ?? {})).toBe(false);
      expect(() => nextState(t.from, t.event, FAIL[t.event] ?? {})).toThrow(
        IllegalTransition,
      );
    });

  it("fails closed when facts are missing", () => {
    expect(() => nextState("DISCOVERING", "DISCOVERY_DONE")).toThrow(
      IllegalTransition,
    );
    expect(() => nextState("DISCOVERING", "DISCOVERY_EMPTY")).toThrow(
      IllegalTransition,
    );
    expect(() =>
      nextState("AWAITING_ENTITY_CONFIRMATION", "USER_CONFIRMED_ENTITIES"),
    ).toThrow(IllegalTransition);
  });

  it("routes CONVERGED by run kind", () => {
    expect(
      nextState("EVALUATING_EVIDENCE", "CONVERGED", {
        terminationMet: true,
        kind: "EXPLORATION",
      }),
    ).toBe("AWAITING_HYPOTHESIS_SELECTION");
    expect(
      nextState("EVALUATING_EVIDENCE", "CONVERGED", {
        terminationMet: true,
        kind: "COUNTERFACTUAL",
      }),
    ).toBe("COMPARING");
    expect(
      nextState("EVALUATING_EVIDENCE", "CONVERGED", {
        terminationMet: true,
        kind: "REVALIDATION",
      }),
    ).toBe("COMPARING");
  });
});

describe("run-kind entry points (TEST_PLAN §4 item 3)", () => {
  const expected: Record<RunKind, string> = {
    EXPLORATION: "ANALYZING_INTENT",
    COUNTERFACTUAL: "PLANNING_COUNTERFACTUAL",
    REVALIDATION: "COLLECTING_EVIDENCE",
    COMPOSITION: "COMPOSING_BLUEPRINT",
  };
  for (const [kind, state] of Object.entries(expected))
    it(`QUEUED → ${state} for ${kind}`, () => {
      expect(nextState("QUEUED", "START", { kind: kind as RunKind })).toBe(
        state,
      );
    });
  it("rejects an unknown kind", () => {
    expect(() =>
      nextState("QUEUED", "START", { kind: "OTHER" as RunKind }),
    ).toThrow(IllegalTransition);
  });
});

describe("global events (TEST_PLAN §4 item 5)", () => {
  for (const event of GLOBAL)
    it(`${event} from every non-terminal state`, () => {
      const target = {
        BUDGET_EXHAUSTED: "COMPLETED_WITH_LIMITS",
        FATAL_ERROR: "FAILED",
        CANCEL: "CANCELLED",
      }[event as "CANCEL"];
      for (const from of NON_TERMINAL)
        expect(nextState(from, event, PASS[event])).toBe(target);
      for (const from of TERMINAL_RUN_STATES)
        expect(() => nextState(from, event, PASS[event])).toThrow(
          IllegalTransition,
        );
    });

  it("allows RETRY only from FAILED into a runnable failed state", () => {
    expect(nextState("FAILED", "RETRY", PASS.RETRY)).toBe(
      "COLLECTING_EVIDENCE",
    );
    expect(() =>
      nextState("FAILED", "RETRY", {
        retryableFailure: true,
        retryState: "AWAITING_BRIEF_CONFIRMATION",
      }),
    ).toThrow(IllegalTransition);
    expect(() =>
      nextState("FAILED", "RETRY", {
        retryableFailure: true,
        retryState: "COMPLETED",
      }),
    ).toThrow(IllegalTransition);
    for (const from of STATES.filter((s) => s !== "FAILED"))
      expect(() => nextState(from, "RETRY", PASS.RETRY)).toThrow(
        IllegalTransition,
      );
  });

  it("classifies paused, runnable, and terminal states", () => {
    expect(STATES.filter(isPaused)).toEqual([
      "AWAITING_BRIEF_CONFIRMATION",
      "AWAITING_ENTITY_CONFIRMATION",
      "AWAITING_HYPOTHESIS_SELECTION",
      "AWAITING_COUNTERFACTUAL_CONFIRMATION",
    ]);
    for (const s of STATES)
      expect(isRunnable(s)).toBe(
        !isPaused(s) && !TERMINAL_RUN_STATES.includes(s),
      );
  });
});
