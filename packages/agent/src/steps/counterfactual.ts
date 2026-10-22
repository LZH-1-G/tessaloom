import {
  AUTO_APPROVE_QLOO_CALLS,
  ComparisonNarrative,
  compareExperiments,
  metricValues,
  renderNarrative,
  templateNarrative,
  type CompareSide,
} from "@tessaloom/core";
import { comparisonNarrativeValidator } from "../validators";
import { MAX_OUTPUT, base, fatal, llmCall, truncate } from "./common";
import { scoreHypotheses } from "./loop";
import type { Ports, StepContext, StepResult } from "./types";

/**
 * COUNTERFACTUAL run steps (AGENT_WORKFLOW §15, ADR-027). The branch was materialized when it
 * was created (held-fixed hypotheses, re-parameterized claims, reused evidence); these steps
 * only decide whether new Qloo calls need the user's approval (gate H4), and finally compare.
 * Collection and evaluation reuse the exploration handlers.
 */
export function planCounterfactualStep(ctx: StepContext): StepResult {
  const dirty = ctx.branch?.plannedDirtyQueries ?? 0;
  const reused = ctx.branch?.plannedReusedQueries ?? 0;
  const planned = ctx.hypotheses.flatMap((h) =>
    h.claims.filter((c) => c.status === "PLANNED"),
  ).length;
  const guard = {
    dirtyQueries: dirty,
    estimatedQlooCalls: dirty,
    autoApproveQlooCalls: AUTO_APPROVE_QLOO_CALLS,
  };
  const acc = base(
    dirty === 0
      ? "DELTA_RESCORE_ONLY"
      : dirty > AUTO_APPROVE_QLOO_CALLS
        ? "DELTA_NEEDS_CONFIRMATION"
        : "DELTA_AUTO_APPROVED",
    guard,
  );
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R5",
    summary: truncate(
      dirty === 0
        ? `No Qloo query depends on this change: ${reused} queries reused; the branch is rescored with existing evidence`
        : `The change affects ${dirty} Qloo ${dirty === 1 ? "query" : "queries"} (${planned} claims to re-test); ${reused} reused unchanged`,
    ),
    payload: {
      dirtyQueries: dirty,
      reusedQueries: reused,
      plannedClaims: planned,
    },
  });
  if (acc.event === "DELTA_NEEDS_CONFIRMATION")
    acc.pendingConfirmation = {
      kind: "COUNTERFACTUAL_COST",
      estimatedQlooCalls: dirty,
      dirtyQueries: dirty,
      reusedQueries: reused,
      maxQlooCalls: ctx.run.budget.maxQlooCalls,
    };
  return acc;
}

/** Override a loaded side's statuses and scores with freshly computed ones. */
function withScores(
  side: CompareSide,
  scored: ReturnType<typeof scoreHypotheses>,
): CompareSide {
  const by = new Map(scored.map((s) => [s.h.id, s]));
  return {
    ...side,
    hypotheses: side.hypotheses.map((h) => {
      const s = by.get(h.id);
      return s
        ? {
            ...h,
            status: s.status,
            compositeScore: s.scores.composite,
            supportScore: s.scores.support,
            noveltyScore: s.scores.novelty,
            feasibilityScore: s.scores.feasibility,
          }
        : h;
    }),
  };
}

export async function compareStep(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  if (!ctx.comparison || !ctx.experiment.parentExperimentId)
    return fatal(
      "COMPARISON_UNAVAILABLE",
      "The branch has no parent to compare",
    );
  const acc = base("COMPARISON_READY", { comparisonCommitted: true });
  // Rescore-only branches arrive here straight from planning: score them now (idempotent).
  const scored = scoreHypotheses(ctx);
  acc.commit.hypothesisUpdates = scored.map(
    ({ h, status, scores, feasibility, noveltyInputs }) => ({
      id: h.id,
      status,
      supportScore: scores.support,
      noveltyScore: scores.novelty,
      feasibilityScore: scores.feasibility,
      compositeScore: scores.composite,
      scoreBreakdown: {
        ...scores.breakdown,
        feasibility: { version: feasibility.version, rules: feasibility.rules },
        noveltyInputs,
      },
    }),
  );
  const metrics = compareExperiments(
    ctx.comparison.parent,
    withScores(ctx.comparison.branch, scored),
    ctx.branch
      ? {
          dirtyQueries: ctx.branch.plannedDirtyQueries,
          reusedQueries: ctx.branch.plannedReusedQueries,
        }
      : undefined,
  );
  const values = metricValues(metrics);
  const evidenceIds = new Set(
    metrics.perClaim
      .flatMap((c) => [c.baseEvidenceId, c.otherEvidenceId])
      .filter((x): x is string => !!x),
  );
  const template = templateNarrative(metrics);
  let narrative: Record<string, unknown> = {
    text: template,
    rendered: renderNarrative(template, values),
    citedEvidenceIds: [],
    provenance: "APP_DERIVED",
    source: "template",
  };

  const result = await llmCall(ctx, ports, acc, {
    role: "R5",
    promptId: "r5.compare",
    label: "R5 comparison narrative",
    input: {
      rescoreOnly: metrics.header.rescoreOnly,
      metricIds: Object.keys(values),
      header: metrics.header,
      hypotheses: metrics.perHypothesis.map((h, i) => ({
        placeholderPrefix: `h${i}`,
        title: h.title,
        from: h.baseStatus,
        to: h.otherStatus,
      })),
      claims: metrics.perClaim
        .filter((c) => c.changed)
        .map((c) => ({
          hypothesis: c.hypothesisTitle,
          statement: c.statement,
          from: c.baseStance,
          to: c.otherStance,
          evidenceIds: [c.baseEvidenceId, c.otherEvidenceId].filter(Boolean),
        })),
    },
    inputExcerpt: {
      dirtyQueries: metrics.header.dirtyQueries,
      changedStances: metrics.header.changedStances,
    },
    schema: ComparisonNarrative,
    maxOutputTokens: MAX_OUTPUT.R5,
    validate: comparisonNarrativeValidator({
      metricIds: new Set(Object.keys(values)),
      evidenceIds,
      rescoreOnly: metrics.header.rescoreOnly,
    }),
  });
  if (result.ok) {
    narrative = {
      text: result.value.text,
      rendered: renderNarrative(result.value.text, values),
      citedEvidenceIds: result.value.citedEvidenceIds,
      provenance: "MODEL_INTERPRETATION",
      source: "r5",
      llmInvocationId: result.invocationIds.at(-1) ?? null,
    };
  } else {
    // The narrative is optional (API_CONTRACTS §4.5): fall back to the deterministic template.
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: "R5",
      summary: truncate(
        `AI narrative unavailable (${result.reason.toLowerCase()}); using the deterministic summary`,
      ),
    });
  }
  acc.commit.comparison = {
    baseExperimentId: ctx.experiment.parentExperimentId,
    otherExperimentId: ctx.experiment.id,
    metrics,
    narrative,
  };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: null,
    summary: truncate(
      `Compared with the parent: ${metrics.header.changedStances} claims changed stance, ${metrics.header.changedStatuses} hypotheses changed status; ${metrics.header.dirtyQueries} queries re-run, ${metrics.header.reusedQueries} reused`,
    ),
    payload: {
      changedStances: metrics.header.changedStances,
      changedStatuses: metrics.header.changedStatuses,
      dirtyQueries: metrics.header.dirtyQueries,
      reusedQueries: metrics.header.reusedQueries,
    },
  });
  return acc;
}
