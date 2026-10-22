import {
  BriefInput,
  ClaimParams,
  ExperimentDefinition,
  IntentFrame,
  RunBudget,
  RunConfig,
  RunUsage,
  type RunState,
} from "@tessaloom/core";
import {
  isRunnable,
  type EntityView,
  type HypothesisView,
  type StepContext,
} from "@tessaloom/agent";
import {
  branchRecord,
  compareSide,
  listRunsForExperiment,
  type Executor,
  type loadRunSnapshot,
} from "@tessaloom/db";

export type RunSnapshot = NonNullable<
  Awaited<ReturnType<typeof loadRunSnapshot>>
>;

/**
 * Active (unpaused) seconds since the run started: the wall-clock budget must not charge the
 * time a run spends waiting for a human at a gate.
 */
export function activeSeconds(
  events: { state: RunState; ts: Date }[],
  now: Date,
): number {
  let total = 0;
  events.forEach((event, i) => {
    if (!isRunnable(event.state)) return;
    const end = events[i + 1]?.ts ?? now;
    total += Math.max(0, end.getTime() - event.ts.getTime());
  });
  return Math.round(total / 1000);
}

export function buildStepContext(
  snap: RunSnapshot,
  now: Date,
  signal?: AbortSignal,
): StepContext {
  const definition = ExperimentDefinition.parse(snap.experiment.definition);
  const intent = IntentFrame.safeParse(snap.brief.intentFrame);
  const entities = new Map<string, EntityView>();
  for (const e of snap.entities)
    entities.set(e.id, {
      id: e.id,
      kind: e.kind,
      qlooId: e.qlooId,
      name: e.name,
      domain: e.domain,
    });
  const tags = new Map<string, string[]>();
  for (const r of snap.hasTag) {
    const list = tags.get(r.fromEntityId) ?? [];
    if (!list.includes(r.toEntityId)) list.push(r.toEntityId);
    tags.set(r.fromEntityId, list);
  }
  const hypotheses: HypothesisView[] = snap.hypotheses.map((h) => ({
    id: h.id,
    lineageId: h.lineageId,
    revisionOfId: h.revisionOfId,
    iteration: h.iteration,
    title: h.title,
    premise: h.premise,
    experienceSketch: h.experienceSketch,
    status: h.status,
    retired: h.retired,
    compositeScore: h.compositeScore,
    collisionCandidateId: h.collisionCandidateId,
    scoreBreakdown:
      (h.scoreBreakdown as Record<string, unknown> | null) ?? null,
    elements: h.elements.map((e) => ({ entityId: e.entityId, role: e.role })),
    claims: h.claims.map((c) => ({
      id: c.id,
      ordinal: c.ordinal,
      statement: c.statement,
      testKind: c.testKind,
      params: ClaimParams.parse(c.testParams),
      status: c.status,
      stance: c.currentStance,
    })),
    evidence: h.evidence.map((e) => ({
      id: e.id,
      claimId: e.claimId,
      stance: e.stance,
      toolInvocationId: e.toolInvocationId,
    })),
  }));
  return {
    run: {
      id: snap.run.id,
      kind: snap.run.kind,
      state: snap.run.state,
      stateVersion: snap.run.stateVersion,
      iteration: snap.run.iteration,
      budget: RunBudget.parse(snap.run.budget),
      usage: RunUsage.parse(snap.run.usage),
      config: RunConfig.parse(snap.run.configSnapshot),
      elapsedSeconds: activeSeconds(snap.stateEvents, now),
    },
    experiment: {
      id: snap.experiment.id,
      projectId: snap.experiment.projectId,
      variables: definition.variables,
      scoringWeights: definition.scoringWeights,
      parentExperimentId: snap.experiment.parentExperimentId,
      variableDelta: definition.variableDelta,
    },
    brief: {
      versionId: snap.brief.id,
      content: BriefInput.parse(snap.brief.content),
      intentFrame: intent.success ? intent.data : null,
    },
    resolutions: snap.resolutions.map((r) => ({
      id: r.id,
      interestIndex: r.interestIndex ?? -1,
      inputText: r.inputText,
      domainHint: r.domainHint,
      requestedKind: r.requestedKind,
      status: r.status,
      selectedEntityId: r.selectedEntityId,
    })),
    seeds: snap.seeds
      .filter((e) => e.role === "seed")
      .map((e) => entities.get(e.id)!),
    location:
      snap.seeds
        .filter((e) => e.role === "location")
        .map((e) => entities.get(e.id)!)[0] ?? null,
    tags,
    entities,
    threads: snap.threads.map((t) => ({
      seedId: t.fromEntityId,
      entityId: t.toEntityId,
      position: Math.round((1 - (t.weight ?? 0)) * 10),
    })),
    pool: snap.pool.map((p) => ({
      id: p.id,
      elementEntityIds: p.elementEntityIds,
      relevance: p.relevance,
      novelty: p.novelty,
      tensionFit: p.tensionFit,
      noveltyInputs: p.noveltyInputs as "FULL" | "REDUCED_INPUTS",
      selected: p.selected,
      rank: p.rank,
    })),
    hypotheses,
    today: now.toISOString().slice(0, 10),
    signal,
  };
}

/**
 * COUNTERFACTUAL runs also need the branch's stored dependency plan, the parent's plan date
 * (trend windows stay comparable), and — when comparing — both sides from the database.
 */
export async function enrichCounterfactualContext(
  db: Executor,
  ctx: StepContext,
): Promise<void> {
  const parentId = ctx.experiment.parentExperimentId;
  if (ctx.run.kind !== "COUNTERFACTUAL" || !parentId) return;
  const branch = await branchRecord(db, ctx.experiment.id);
  ctx.branch = branch
    ? {
        plannedDirtyQueries: branch.plannedDirtyQueries,
        plannedReusedQueries: branch.plannedReusedQueries,
        mode: branch.mode,
      }
    : null;
  const [parentRun] = await listRunsForExperiment(db, parentId);
  if (parentRun)
    ctx.today = (parentRun.startedAt ?? parentRun.createdAt)
      .toISOString()
      .slice(0, 10);
  if (ctx.run.state === "COMPARING")
    ctx.comparison = {
      parent: await compareSide(db, parentId),
      branch: await compareSide(db, ctx.experiment.id),
    };
}
