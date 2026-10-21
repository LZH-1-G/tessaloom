import {
  CritiqueReport,
  HypothesisBatch,
  HypothesisRevision,
  uuidv7,
  type EvidenceStance,
  type HypothesisDraft,
  type HypothesisStatus,
} from "@tessaloom/core";
import { addUsage as addUsageLocal, remaining } from "../budget";
import { EVALUATION_RULESET, evaluateClaim } from "../evaluators";
import {
  checkTermination,
  computeStatus,
  scoreHypothesis,
  type ClaimState,
} from "../hypothesis";
import { planEvidence, type PlanEntity, type PlannedQuery } from "../planner";
import type { QlooResult } from "../ports";
import {
  combine,
  critiqueValidator,
  hypothesisBatchValidator,
  hypothesisRevisionValidator,
  safeUseValidator,
} from "../validators";
import {
  Cancelled,
  MAX_OUTPUT,
  base,
  failLlm,
  llmCall,
  provenanceOf,
  qctx,
  qlooCall,
  qlooFailure,
  truncate,
} from "./common";
import type {
  ClaimView,
  CommitPlan,
  HypothesisView,
  Ports,
  StepContext,
  StepResult,
} from "./types";

/** The collision candidates selected for generation (gate H2b may have re-selected them). */
export const selectedPool = (ctx: StepContext) =>
  ctx.pool
    .filter((p) => p.selected)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

/**
 * EntityGroundingValidator scope (AGENT_WORKFLOW §13.2): every entity of this experiment —
 * seeds, thread results, their tags, and the venue locality. The pool is what R3 is asked to
 * weave from; the rest is available for claim parameters such as shortlist options.
 */
export function groundingContext(ctx: StepContext) {
  const ids = new Set<string>([
    ...ctx.seeds.map((s) => s.id),
    ...selectedPool(ctx).flatMap((p) => p.elementEntityIds),
    ...ctx.threads.map((t) => t.entityId),
    ...[...ctx.tags.values()].flat(),
  ]);
  for (const h of ctx.hypotheses)
    h.elements.forEach((e) => ids.add(e.entityId));
  const domainOf = new Map<string, string>();
  for (const id of ids) {
    const d = ctx.entities.get(id)?.domain;
    if (d) domainOf.set(id, d);
  }
  return {
    entityIds: ids,
    tagIds: new Set(
      [...ids].filter((id) => ctx.entities.get(id)?.kind === "tag"),
    ),
    domainOf,
    maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
  };
}

export function poolInput(ctx: StepContext) {
  const view = (id: string) => {
    const e = ctx.entities.get(id);
    return {
      entityId: id,
      name: e?.name ?? "unknown",
      domain: e?.domain ?? null,
    };
  };
  const inPool = new Set(selectedPool(ctx).flatMap((p) => p.elementEntityIds));
  const discovered = [
    ...new Set([
      ...ctx.threads.map((t) => t.entityId),
      ...[...ctx.tags.values()].flat(),
    ]),
  ]
    .filter((id) => !inPool.has(id) && !ctx.seeds.some((s) => s.id === id))
    .slice(0, 80);
  return {
    seeds: ctx.seeds.map((s) => view(s.id)),
    pool: selectedPool(ctx).map((p) => ({
      candidateId: p.id,
      rank: p.rank,
      elements: p.elementEntityIds.map(view),
      noveltyInputs: p.noveltyInputs,
    })),
    discovered: discovered.map(view),
    ...(ctx.location ? { venueLocality: view(ctx.location.id) } : {}),
  };
}

export function matchCandidate(
  ctx: StepContext,
  draft: HypothesisDraft,
): string | null {
  const ids = new Set(draft.elementRefs.map((r) => r.entityId));
  return (
    selectedPool(ctx).find((p) => p.elementEntityIds.every((id) => ids.has(id)))
      ?.id ?? null
  );
}

export const allowedKinds = (ctx: StepContext) => [
  "CROSS_DOMAIN_AFFINITY",
  "SHORTLIST_FIT",
  "AUDIENCE_BRIDGE",
  "TAG_RESONANCE",
  "MOMENTUM",
  "AUDIENCE_PROFILE",
  ...(ctx.experiment.variables.locationQlooId ? ["LOCATION_FIT"] : []),
];

export async function generateHypotheses(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("HYPOTHESES_READY");
  const grounding = groundingContext(ctx);
  const result = await llmCall(ctx, ports, acc, {
    role: "R3",
    promptId: "r3.generate",
    label: "R3 hypothesis generation",
    input: {
      brief: {
        title: ctx.brief.content.title,
        challenge: ctx.brief.content.challenge,
        goals: ctx.brief.content.goals,
        venue: ctx.brief.content.venue,
        constraints: ctx.brief.content.constraints,
      },
      ...poolInput(ctx),
      limits: {
        maxHypotheses: ctx.run.budget.maxHypotheses,
        maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
      },
      allowedTestKinds: allowedKinds(ctx),
    },
    inputExcerpt: {
      poolSize: selectedPool(ctx).length,
      seedCount: ctx.seeds.length,
      iteration: ctx.run.iteration,
    },
    schema: HypothesisBatch,
    maxOutputTokens: MAX_OUTPUT.R3,
    validate: combine(hypothesisBatchValidator(grounding), safeUseValidator),
  });
  if (!result.ok) return failLlm(result, "R3 hypothesis generation", acc);
  const drafts = result.value.hypotheses.slice(
    0,
    Math.max(1, ctx.run.budget.maxHypotheses),
  );
  const invocationId = result.invocationIds.at(-1)!;
  acc.commit.hypotheses = drafts.map((draft) => ({
    draft,
    llmInvocationId: invocationId,
    iteration: ctx.run.iteration,
    revisionOfId: null,
    lineageId: null,
    collisionCandidateId: matchCandidate(ctx, draft),
  }));
  acc.guard = { validHypotheses: drafts.length };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R3",
    summary: truncate(result.value.decisionSummary),
  });
  return acc;
}

export const active = (ctx: StepContext) =>
  ctx.hypotheses.filter((h) => !h.retired);

export function makePlan(ctx: StepContext) {
  const entities = new Map<string, PlanEntity>();
  for (const [id, e] of ctx.entities)
    entities.set(id, { qlooId: e.qlooId, domain: e.domain, kind: e.kind });
  return planEvidence({
    claims: active(ctx).flatMap((h) =>
      h.claims
        .filter((c) => c.status === "PLANNED")
        .map((c) => ({
          claimId: c.id,
          hypothesisId: h.id,
          testKind: c.testKind,
          params: c.params,
          priority: h.compositeScore,
          ordinal: c.ordinal,
        })),
    ),
    entities,
    remainingQlooCalls: remaining(
      ctx.run.budget,
      ctx.run.usage,
      ctx.run.elapsedSeconds,
    ).qlooCalls,
    locationQlooId:
      ctx.location?.qlooId ?? ctx.experiment.variables.locationQlooId,
    timeWindowWeeks: ctx.experiment.variables.timeWindowWeeks,
    today: ctx.today,
  });
}

export function planStep(ctx: StepContext): StepResult {
  const acc = base("PLAN_READY");
  const plan = makePlan(ctx);
  acc.commit.claimOutcomes = [
    ...plan.untestedBudget.map((claimId) => ({
      claimId,
      status: "UNTESTED_BUDGET" as const,
    })),
    ...plan.unsupported.map((u) => ({
      claimId: u.claimId,
      status: "UNSUPPORTED" as const,
    })),
  ];
  const planned = new Set(plan.queries.flatMap((q) => q.claimIds));
  acc.commit.hypothesisUpdates = active(ctx)
    .filter((h) => h.claims.some((c) => planned.has(c.id)))
    .map((h) => ({ id: h.id, status: "UNDER_INVESTIGATION" as const }));
  acc.guard = {
    planWithinBudget:
      plan.queries.length <=
      remaining(ctx.run.budget, ctx.run.usage, ctx.run.elapsedSeconds)
        .qlooCalls,
  };
  if (plan.queries.length === 0 && plan.untestedBudget.length > 0) {
    // Termination rule 4: no planned query fits the remaining Qloo budget.
    acc.event = "BUDGET_EXHAUSTED";
    acc.guard = { outputsConsistent: true };
    acc.terminalReason = "BUDGET:maxQlooCalls";
  }
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(
      `Evidence plan: ${plan.queries.length} Qloo queries for ${planned.size} claims; ${plan.untestedBudget.length} trimmed by budget; ${plan.unsupported.length} untestable`,
    ),
    payload: {
      queries: plan.queries.map((q) => ({
        method: q.method,
        claims: q.claimIds.length,
      })),
    },
  });
  return acc;
}

async function runQuery(
  ports: Ports,
  q: PlannedQuery,
  ctx: ReturnType<typeof qctx>,
): Promise<QlooResult<unknown>> {
  const i = q.input as never;
  switch (q.method) {
    case "recommend":
      return ports.qloo.recommend(i, ctx);
    case "rank":
      return ports.qloo.rank(i, ctx);
    case "compareAudiences":
      return ports.qloo.compareAudiences(i, ctx);
    case "entityTags":
      return ports.qloo.entityTags(i, ctx);
    case "wherePopular":
      return ports.qloo.wherePopular(i, ctx);
    case "trends":
      return ports.qloo.trends(i, ctx);
    case "audienceDemographics":
      return ports.qloo.audienceDemographics(i, ctx);
  }
}

export async function collect(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("COLLECTION_DONE");
  const plan = makePlan(ctx);
  const claims = new Map(
    active(ctx).flatMap((h) =>
      h.claims.map((c) => [c.id, { claim: c, hypothesisId: h.id }] as const),
    ),
  );
  const outcomes: NonNullable<CommitPlan["claimOutcomes"]> = [];
  const evidence: NonNullable<CommitPlan["evidence"]> = [];
  let rateLimited = 0;
  for (const q of plan.queries) {
    let result: QlooResult<unknown>;
    try {
      result = await qlooCall(
        ctx,
        acc,
        q.method,
        () => runQuery(ports, q, qctx(ctx, `evidence:${q.claimIds[0]}`)),
        `${q.claimIds.length} claim(s)`,
      );
    } catch (error) {
      // Cancelled mid-collection: keep what was graded so far (AGENT_WORKFLOW §9).
      if (error instanceof Cancelled)
        return {
          ...base("CANCEL"),
          commit: { claimOutcomes: outcomes, evidence },
          events: acc.events,
          usage: acc.usage,
          terminalReason: "USER_CANCELLED",
        };
      throw error;
    }
    const failed = qlooFailure(result);
    if (failed)
      return {
        ...failed,
        events: acc.events,
        usage: acc.usage,
        commit: { claimOutcomes: outcomes, evidence },
      };
    if (result.kind === "ERROR" && /RATE/i.test(result.code)) rateLimited++;
    const prov = "provenance" in result ? result.provenance : null;
    for (const claimId of q.claimIds) {
      const entry = claims.get(claimId)!;
      const evaluation = evaluateClaim(
        entry.claim.testKind,
        plan.resolved.get(claimId)!,
        result,
      );
      const recordable =
        !!prov?.toolInvocationId && evaluation.claimStatus === "TESTED";
      outcomes.push({
        claimId,
        status: recordable
          ? "TESTED"
          : evaluation.claimStatus === "TESTED"
            ? "FAILED"
            : evaluation.claimStatus,
        stance: recordable ? evaluation.stance : null,
        queryRequestHash: prov?.requestHash ?? null,
      });
      if (recordable)
        evidence.push({
          id: uuidv7(),
          claimId,
          hypothesisId: entry.hypothesisId,
          toolInvocationId: prov!.toolInvocationId!,
          stance: evaluation.stance,
          evaluatorId: evaluation.evaluatorId,
          rulesetVersion: EVALUATION_RULESET.version,
          facts: evaluation.facts,
          primaryMeasure: evaluation.primaryMeasure,
          quality: evaluation.quality,
          provenanceClass: provenanceOf(prov),
        });
    }
  }
  acc.commit.claimOutcomes = outcomes;
  acc.commit.evidence = evidence;
  acc.guard = { allQueriesFinal: true };
  if (plan.queries.length > 0 && rateLimited / plan.queries.length >= 0.5)
    return {
      ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
      commit: acc.commit,
      events: acc.events,
      usage: acc.usage,
      terminalReason: "RATE_LIMITED",
    };
  const stances = evidence.reduce<Record<string, number>>(
    (m, e) => ({ ...m, [e.stance]: (m[e.stance] ?? 0) + 1 }),
    {},
  );
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(
      `Graded ${evidence.length} claims deterministically: ${
        Object.entries(stances)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ") || "none"
      }`,
    ),
  });
  return acc;
}

function claimStates(
  h: HypothesisView,
  outcomes?: Map<
    string,
    { stance: EvidenceStance | null; status: ClaimView["status"] }
  >,
): ClaimState[] {
  return h.claims.map((c) => {
    const o = outcomes?.get(c.id);
    const latest = [...h.evidence].reverse().find((e) => e.claimId === c.id);
    return {
      stance: o?.stance ?? c.stance,
      status: o?.status ?? c.status,
      toolInvocationId: latest?.toolInvocationId ?? null,
    };
  });
}

export async function evaluate(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("CONVERGED");
  const hyps = active(ctx);
  const computed = hyps.map((h) => {
    const states = claimStates(h);
    const novelty =
      ctx.pool.find((p) => p.id === h.collisionCandidateId)?.novelty ?? 0.5;
    const scores = scoreHypothesis({
      claims: states,
      novelty,
      feasibility: 0.6,
      weights: ctx.experiment.scoringWeights,
    });
    return { h, status: computeStatus(states), scores };
  });

  const result = await llmCall(ctx, ports, acc, {
    role: "R4",
    promptId: "r4.critique",
    label: "R4 evidence critique",
    input: {
      hypotheses: computed.map(({ h, status }) => ({
        hypothesisId: h.id,
        title: h.title,
        premise: h.premise,
        status,
        claims: h.claims.map((c) => ({
          statement: c.statement,
          testKind: c.testKind,
          status: c.status,
          stance: c.stance,
          evidence: h.evidence
            .filter((e) => e.claimId === c.id)
            .map((e) => ({ evidenceId: e.id, stance: e.stance })),
        })),
      })),
    },
    inputExcerpt: {
      hypothesisCount: hyps.length,
      iteration: ctx.run.iteration,
    },
    schema: CritiqueReport,
    maxOutputTokens: MAX_OUTPUT.R4,
    validate: combine(
      critiqueValidator({
        hypothesisIds: new Set(hyps.map((h) => h.id)),
        evidenceByHypothesis: new Map(
          hyps.map((h) => [h.id, new Set(h.evidence.map((e) => e.id))]),
        ),
      }),
      safeUseValidator,
    ),
  });
  if (!result.ok) return failLlm(result, "R4 evidence critique", acc);
  const critique = new Map(
    result.value.perHypothesis.map((p) => [p.hypothesisId, p]),
  );

  acc.commit.hypothesisUpdates = computed.map(({ h, status, scores }) => {
    const c = critique.get(h.id);
    return {
      id: h.id,
      status,
      supportScore: scores.support,
      noveltyScore: scores.novelty,
      feasibilityScore: scores.feasibility,
      compositeScore: scores.composite,
      scoreBreakdown: {
        ...scores.breakdown,
        feasibilityRule: "baseline-m4",
        // The critic can only add interpretation or a downgrade; it never changes a stance.
        ...(c
          ? {
              critique: {
                recommendation: c.recommendation,
                confidenceNote: c.confidenceNote ?? null,
                downgrade: c.downgrade ?? null,
                citedEvidenceIds: c.citedEvidenceIds,
                refinementHint: c.refinementHint ?? null,
              },
            }
          : {}),
      },
    };
  });

  const previous = new Map<string, HypothesisStatus>();
  for (const { h } of computed) {
    const prior = h.revisionOfId
      ? ctx.hypotheses.find((x) => x.id === h.revisionOfId)
      : h;
    previous.set(h.lineageId, prior?.status ?? h.status);
  }
  const newDecisive = computed
    .filter(({ h }) => h.iteration === ctx.run.iteration)
    .flatMap(({ h }) => h.claims)
    .filter(
      (c) => c.stance === "SUPPORTS" || c.stance === "CONTRADICTS",
    ).length;
  const termination = checkTermination({
    hypotheses: computed.map(({ h, status, scores }) => ({
      id: h.lineageId,
      status,
      composite: scores.composite,
    })),
    previousStatuses: previous,
    newDecisiveStances: newDecisive,
    iteration: ctx.run.iteration,
    maxIterations: ctx.run.budget.maxIterations,
  });
  acc.guard = { terminationMet: termination.met, kind: ctx.run.kind };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(result.value.decisionSummary),
  });
  const left = remaining(
    ctx.run.budget,
    addUsageLocal(ctx.run.usage, acc.usage),
    ctx.run.elapsedSeconds,
  );
  if (!termination.met && (left.qlooCalls <= 0 || left.llmCalls < 2)) {
    // Termination rule 4: another revision round (R3 + R4, plus evidence) no longer fits.
    acc.event = "BUDGET_EXHAUSTED";
    acc.guard = { outputsConsistent: true };
    acc.terminalReason =
      left.qlooCalls <= 0 ? "BUDGET:maxQlooCalls" : "BUDGET:maxLlmCalls";
    return acc;
  }
  if (termination.met) {
    const ranked = [...computed]
      .sort((a, b) => b.scores.composite - a.scores.composite)
      .map(({ h }) => h.id);
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: null,
      summary: truncate(
        `Hypothesis loop ended (${termination.rule}) after iteration ${ctx.run.iteration + 1}`,
      ),
      payload: { rule: termination.rule },
    });
    if (ctx.run.kind === "EXPLORATION")
      acc.pendingConfirmation = {
        kind: "HYPOTHESIS_SELECTION",
        hypothesisIds: ranked,
      };
  } else {
    acc.event = "REVISE";
  }
  return acc;
}

export async function revise(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("REVISION_READY");
  const hyps = active(ctx);
  const grounding = groundingContext(ctx);
  const used = new Set(hyps.flatMap((h) => h.elements.map((e) => e.entityId)));
  const result = await llmCall(ctx, ports, acc, {
    role: "R3",
    promptId: "r3.revise",
    label: "R3 hypothesis revision",
    input: {
      hypotheses: hyps.map((h) => ({
        hypothesisId: h.id,
        title: h.title,
        premise: h.premise,
        status: h.status,
        elements: h.elements,
        claims: h.claims.map((c) => ({
          statement: c.statement,
          testKind: c.testKind,
          params: c.params,
          stance: c.stance,
          status: c.status,
        })),
        critique:
          (h.scoreBreakdown as { critique?: unknown } | null)?.critique ?? null,
      })),
      ...poolInput(ctx),
      unusedPoolEntityIds: [...grounding.entityIds].filter(
        (id) => !used.has(id),
      ),
      limits: {
        maxSpawn: 2,
        maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
      },
      allowedTestKinds: allowedKinds(ctx),
    },
    inputExcerpt: {
      hypothesisCount: hyps.length,
      iteration: ctx.run.iteration,
    },
    schema: HypothesisRevision,
    maxOutputTokens: MAX_OUTPUT.R3,
    validate: combine(
      hypothesisRevisionValidator({
        ...grounding,
        hypothesisIds: new Set(hyps.map((h) => h.id)),
      }),
      safeUseValidator,
    ),
  });
  if (!result.ok) return failLlm(result, "R3 hypothesis revision", acc);
  const next = ctx.run.iteration + 1;
  const invocationId = result.invocationIds.at(-1)!;
  const byId = new Map(hyps.map((h) => [h.id, h]));
  acc.commit.hypotheses = [
    ...result.value.refined.map(({ revisionOfId, ...draft }) => ({
      draft,
      llmInvocationId: invocationId,
      iteration: next,
      revisionOfId,
      lineageId: byId.get(revisionOfId)!.lineageId,
      collisionCandidateId: byId.get(revisionOfId)!.collisionCandidateId,
    })),
    ...result.value.spawned.map((draft) => ({
      draft,
      llmInvocationId: invocationId,
      iteration: next,
      revisionOfId: null,
      lineageId: null,
      collisionCandidateId: matchCandidate(ctx, draft),
    })),
  ];
  // Superseded and retired hypotheses stay visible (retired = true); their stances never change.
  acc.commit.hypothesisUpdates = [
    ...result.value.refined.map((r) => ({ id: r.revisionOfId, retired: true })),
    ...result.value.retiredIds.map((id) => ({ id, retired: true })),
  ];
  acc.iteration = next;
  acc.guard = { iterationIncremented: true };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R3",
    summary: truncate(result.value.decisionSummary),
  });
  return acc;
}
