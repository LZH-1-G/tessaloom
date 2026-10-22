import type { CommitPlan, EntityRef } from "@tessaloom/agent";
import {
  createResolution,
  insertCollisionCandidates,
  commitBlueprint,
  insertEvidence,
  saveComparison,
  insertExperimentSeeds,
  insertHypothesis,
  insertRelations,
  recordResolutionCandidates,
  selectResolutionCandidate,
  setClaimOutcome,
  setIntentFrame,
  updateCollisionCandidate,
  updateHypothesis,
  upsertCulturalEntity,
  type Tx,
} from "@tessaloom/db";

export interface CommitScope {
  experimentId: string;
  projectId: string;
  workspaceId: string;
  runId: string;
  briefVersionId: string;
  /** COMPOSITION runs only. */
  blueprintId?: string | null;
}

/**
 * Persist one step's records inside the step transaction (AGENT_WORKFLOW §6.2). Entity
 * references by Qloo identity are resolved to the rows upserted in the same commit.
 */
export async function applyCommit(
  tx: Tx,
  scope: CommitScope,
  plan: CommitPlan,
): Promise<void> {
  const byQloo = new Map<string, string>();
  const key = (kind: string, qlooId: string) => `${kind}:${qlooId}`;
  const resolve = (ref: EntityRef): string => {
    if (typeof ref === "string") return ref;
    const id = byQloo.get(key(ref.kind, ref.qlooId));
    if (!id) throw new Error(`Unresolved entity reference ${ref.kind}`);
    return id;
  };

  if (plan.intent) await setIntentFrame(tx, plan.intent);

  for (const e of plan.entities ?? []) {
    const k = key(e.kind, e.qlooId);
    if (byQloo.has(k)) continue;
    const row = await upsertCulturalEntity(tx, {
      workspaceId: scope.workspaceId,
      kind: e.kind,
      qlooId: e.qlooId,
      name: e.name,
      qlooType: e.qlooType ?? null,
      domain: e.domain ?? null,
      disambiguation: e.disambiguation ?? null,
      legacyType: e.legacyType ?? false,
      snapshot: e.snapshot,
      sourceToolInvocationId: e.sourceToolInvocationId,
      provenanceClass: e.provenanceClass,
    });
    byQloo.set(k, row.id);
  }

  for (const r of plan.resolutions ?? []) {
    const id =
      r.existingId ??
      (
        await createResolution(tx, {
          projectId: scope.projectId,
          briefVersionId: scope.briefVersionId,
          runId: scope.runId,
          interestIndex: r.interestIndex,
          inputText: r.inputText,
          domainHint: r.domainHint,
          requestedKind: r.requestedKind,
        })
      ).id;
    await recordResolutionCandidates(tx, {
      resolutionId: id,
      candidates: r.candidates,
      toolInvocationIds: r.toolInvocationIds,
    });
    if (r.selected)
      await selectResolutionCandidate(tx, {
        resolutionId: id,
        entityId: resolve(r.selected),
        method: "EXACT_SINGLE",
      });
  }

  if (plan.seeds?.length)
    await insertExperimentSeeds(
      tx,
      scope.experimentId,
      plan.seeds.map((s) => ({ entityId: resolve(s.ref), role: s.role })),
    );

  if (plan.relations?.length) {
    const seen = new Set<string>();
    const rows = plan.relations
      .map((r) => ({ ...r, fromId: resolve(r.from), toId: resolve(r.to) }))
      .filter((r) => {
        const k = `${r.kind}:${r.fromId}:${r.toId}`;
        if (r.fromId === r.toId || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    await insertRelations(
      tx,
      rows.map((r) => ({
        experimentId: scope.experimentId,
        fromEntityId: r.fromId,
        toEntityId: r.toId,
        kind: r.kind,
        provenanceClass: r.provenanceClass,
        toolInvocationIds: r.toolInvocationIds,
        facts: r.facts,
        weight: r.weight,
      })),
    );
  }

  for (const p of plan.poolSelection ?? [])
    await updateCollisionCandidate(tx, p.id, {
      selected: p.selected,
      rank: p.rank,
      tensionFit: p.tensionFit,
    });

  if (plan.collisionCandidates?.length)
    await insertCollisionCandidates(
      tx,
      plan.collisionCandidates.map((c) => ({
        experimentId: scope.experimentId,
        ...c,
      })),
    );

  for (const h of plan.hypotheses ?? []) {
    await insertHypothesis(tx, {
      experimentId: scope.experimentId,
      runId: scope.runId,
      llmInvocationId: h.llmInvocationId,
      iteration: h.iteration,
      title: h.draft.title,
      premise: h.draft.premise,
      experienceSketch: h.draft.experienceSketch,
      creativeElements: h.draft.creativeElements,
      scoringVersion: "scoring-1.0.0",
      collisionCandidateId: h.collisionCandidateId,
      revisionOfId: h.revisionOfId,
      lineageId: h.lineageId,
      elements: h.draft.elementRefs,
      claims: h.draft.claims.map((c) => ({
        statement: c.statement,
        testKind: c.testKind,
        testParams: c.params,
      })),
    });
  }

  for (const u of plan.hypothesisUpdates ?? []) {
    const { id, ...patch } = u;
    await updateHypothesis(tx, id, patch);
  }

  for (const o of plan.claimOutcomes ?? []) await setClaimOutcome(tx, o);

  for (const e of plan.evidence ?? [])
    await insertEvidence(tx, {
      ...e,
      experimentId: scope.experimentId,
      runId: scope.runId,
    });

  if (plan.blueprint && scope.blueprintId)
    await commitBlueprint(tx, {
      blueprintId: scope.blueprintId,
      runId: scope.runId,
      ...plan.blueprint,
    });

  if (plan.comparison)
    await saveComparison(tx, {
      projectId: scope.projectId,
      baseExperimentId: plan.comparison.baseExperimentId,
      otherExperimentId: plan.comparison.otherExperimentId,
      kind: "COUNTERFACTUAL",
      metrics: plan.comparison.metrics,
      narrative: plan.comparison.narrative,
    });
}
