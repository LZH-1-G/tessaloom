import type { EvidenceStance, HypothesisStatus } from "@tessaloom/core";

export const SCORING_VERSION = "scoring-1.0.0";

export interface ClaimState {
  stance: EvidenceStance | null; // latest deterministic stance; null = untested
  status: "PLANNED" | "TESTED" | "UNTESTED_BUDGET" | "UNSUPPORTED" | "FAILED";
  toolInvocationId: string | null;
}

/** AGENT_WORKFLOW §12 status table (APP_DERIVED). */
export function computeStatus(
  claims: ClaimState[],
  inProgress = false,
): HypothesisStatus {
  const tested = claims.filter((c) => c.stance !== null);
  if (claims.length > 0 && claims.every((c) => c.status === "UNSUPPORTED"))
    return "UNTESTABLE";
  if (tested.length === 0) {
    if (claims.some((c) => c.status === "FAILED")) return "INCONCLUSIVE";
    return inProgress ? "UNDER_INVESTIGATION" : "SPECULATIVE";
  }
  const supports = tested.filter((c) => c.stance === "SUPPORTS");
  const contradicts = tested.filter((c) => c.stance === "CONTRADICTS");
  const insufficient = tested.filter((c) => c.stance === "INSUFFICIENT");
  const invocations = new Set(
    supports.map((c) => c.toolInvocationId).filter(Boolean),
  );
  if (supports.length >= 2 && contradicts.length === 0 && invocations.size >= 2)
    return "SUPPORTED";
  if (
    supports.length >= 1 &&
    (contradicts.length >= 1 || insufficient.length >= 1)
  )
    return "PARTIALLY_SUPPORTED";
  if (supports.length === 0 && contradicts.length > tested.length / 2)
    return "CONTRADICTED";
  if (insufficient.length === tested.length) return "INCONCLUSIVE";
  // One SUPPORTS without a second independent invocation, or NEUTRAL-only results.
  return supports.length >= 1 ? "PARTIALLY_SUPPORTED" : "INCONCLUSIVE";
}

export interface ScoreInput {
  claims: ClaimState[];
  /** 0..1 from the collision candidate (novelty of the element combination). */
  novelty: number;
  /** 0..1 rule-based feasibility against the brief constraints. */
  feasibility: number;
  weights: { support: number; novelty: number; feasibility: number };
}

export interface Scores {
  support: number;
  novelty: number;
  feasibility: number;
  composite: number;
  breakdown: Record<string, number | string>;
}

const clamp100 = (v: number) =>
  Math.max(0, Math.min(100, Math.round(v * 10) / 10));

/** §16 step 6: composite = w_s·support + w_n·novelty + w_f·feasibility, all 0–100. */
export function scoreHypothesis(input: ScoreInput): Scores {
  const tested = input.claims.filter(
    (c) => c.stance !== null && c.stance !== "NEUTRAL",
  );
  const raw =
    tested.length === 0
      ? 0
      : tested.reduce(
          (sum, c) =>
            sum +
            (c.stance === "SUPPORTS" ? 1 : c.stance === "CONTRADICTS" ? -1 : 0),
          0,
        ) / tested.length;
  // Map [-1, 1] to [0, 100]; untested hypotheses sit at the neutral midpoint.
  const support = clamp100(((raw + 1) / 2) * 100);
  const novelty = clamp100(input.novelty * 100);
  const feasibility = clamp100(input.feasibility * 100);
  const composite = clamp100(
    input.weights.support * support +
      input.weights.novelty * novelty +
      input.weights.feasibility * feasibility,
  );
  return {
    support,
    novelty,
    feasibility,
    composite,
    breakdown: {
      testedClaims: tested.length,
      supportRaw: Number(raw.toFixed(4)),
      weightSupport: input.weights.support,
      weightNovelty: input.weights.novelty,
      weightFeasibility: input.weights.feasibility,
      scoringVersion: SCORING_VERSION,
    },
  };
}

export interface TerminationInput {
  /** Active hypotheses with their current status and composite score. */
  hypotheses: { id: string; status: HypothesisStatus; composite: number }[];
  /** Statuses before this iteration's evaluation (by hypothesis lineage or id). */
  previousStatuses: Map<string, HypothesisStatus>;
  newDecisiveStances: number; // SUPPORTS/CONTRADICTS added in this iteration
  iteration: number;
  maxIterations: number;
}

export type TerminationRule =
  "CONVERGENCE" | "DIMINISHING_RETURNS" | "ITERATION_LIMIT";

const SETTLED: HypothesisStatus[] = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "CONTRADICTED",
  "UNTESTABLE",
];

/** §12 termination rules 1–3 (rule 4, budget, is enforced by the step runner). */
export function checkTermination(input: TerminationInput): {
  met: boolean;
  rule: TerminationRule | null;
} {
  const top = [...input.hypotheses]
    .sort((a, b) => b.composite - a.composite)
    .slice(0, Math.min(3, input.hypotheses.length));
  if (top.length > 0 && top.every((h) => SETTLED.includes(h.status)))
    return { met: true, rule: "CONVERGENCE" };
  if (input.iteration > 0) {
    const changed = input.hypotheses.some(
      (h) => input.previousStatuses.get(h.id) !== h.status,
    );
    if (!changed && input.newDecisiveStances < 2)
      return { met: true, rule: "DIMINISHING_RETURNS" };
  }
  if (input.iteration + 1 >= input.maxIterations)
    return { met: true, rule: "ITERATION_LIMIT" };
  return { met: false, rule: null };
}
