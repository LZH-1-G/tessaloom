import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../client";
import { NotFoundError } from "../errors";
import {
  agentRuns,
  briefVersions,
  collisionCandidates,
  culturalEntities,
  entityRelations,
  entityResolutionRecords,
  evidenceRecords,
  experimentSeeds,
  experiments,
  hypotheses,
  hypothesisClaims,
  hypothesisElements,
  llmInvocations,
  projects,
  qlooResponseSnapshots,
  toolInvocations,
} from "../schema";

import { sourceRetrievedAt } from "./qloo";

/** Read models for the product pages (API_CONTRACTS §9). Every read is workspace-scoped. */

export async function projectOverview(
  db: Executor,
  workspaceId: string,
  projectId: string,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)),
    );
  if (!project) throw new NotFoundError("Project not found");
  const [briefs, exps] = await Promise.all([
    db
      .select({
        id: briefVersions.id,
        version: briefVersions.version,
        content: briefVersions.content,
        confirmedAt: briefVersions.confirmedAt,
        createdAt: briefVersions.createdAt,
      })
      .from(briefVersions)
      .where(eq(briefVersions.projectId, projectId))
      .orderBy(desc(briefVersions.version)),
    db
      .select()
      .from(experiments)
      .where(eq(experiments.projectId, projectId))
      .orderBy(desc(experiments.createdAt)),
  ]);
  const runs = exps.length
    ? await db
        .select()
        .from(agentRuns)
        .where(
          inArray(
            agentRuns.experimentId,
            exps.map((e) => e.id),
          ),
        )
        .orderBy(desc(agentRuns.createdAt))
    : [];
  return {
    project,
    briefs,
    experiments: exps.map((e) => ({
      id: e.id,
      briefVersionId: e.briefVersionId,
      status: e.status,
      mode: e.mode,
      kind: e.kind,
      label: e.label,
      createdAt: e.createdAt,
      latestRun: runs.find((r) => r.experimentId === e.id) ?? null,
    })),
  };
}

export async function experimentView(
  db: Executor,
  workspaceId: string,
  experimentId: string,
) {
  const [row] = await db
    .select({ experiment: experiments })
    .from(experiments)
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(
      and(
        eq(experiments.id, experimentId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Experiment not found");
  const { experiment } = row;
  const [brief, runs, resolutions, seeds, relations, pool, hyps] =
    await Promise.all([
      db
        .select()
        .from(briefVersions)
        .where(eq(briefVersions.id, experiment.briefVersionId)),
      db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.experimentId, experimentId))
        .orderBy(desc(agentRuns.createdAt)),
      db
        .select()
        .from(entityResolutionRecords)
        .where(
          eq(entityResolutionRecords.briefVersionId, experiment.briefVersionId),
        )
        .orderBy(
          asc(entityResolutionRecords.interestIndex),
          desc(entityResolutionRecords.createdAt),
          desc(entityResolutionRecords.id),
        ),
      db
        .select()
        .from(experimentSeeds)
        .where(eq(experimentSeeds.experimentId, experimentId))
        .orderBy(asc(experimentSeeds.ordinal)),
      db
        .select()
        .from(entityRelations)
        .where(eq(entityRelations.experimentId, experimentId)),
      db
        .select()
        .from(collisionCandidates)
        .where(eq(collisionCandidates.experimentId, experimentId))
        .orderBy(asc(collisionCandidates.rank), asc(collisionCandidates.id)),
      db
        .select()
        .from(hypotheses)
        .where(eq(hypotheses.experimentId, experimentId))
        .orderBy(asc(hypotheses.createdAt), asc(hypotheses.id)),
    ]);
  // Latest resolution per interest (refinements create new records).
  const seenIndex = new Set<number>();
  const latestResolutions = resolutions.filter((r) => {
    const k = r.interestIndex ?? -1;
    if (seenIndex.has(k)) return false;
    seenIndex.add(k);
    return true;
  });
  const hypIds = hyps.map((h) => h.id);
  const [elements, claims, evidence] = hypIds.length
    ? await Promise.all([
        db
          .select()
          .from(hypothesisElements)
          .where(inArray(hypothesisElements.hypothesisId, hypIds)),
        db
          .select()
          .from(hypothesisClaims)
          .where(inArray(hypothesisClaims.hypothesisId, hypIds))
          .orderBy(asc(hypothesisClaims.ordinal)),
        db
          .select({
            evidence: evidenceRecords,
            dataOrigin: toolInvocations.dataOrigin,
            retrievedAt: sourceRetrievedAt,
          })
          .from(evidenceRecords)
          .leftJoin(
            toolInvocations,
            eq(toolInvocations.id, evidenceRecords.toolInvocationId),
          )
          .where(inArray(evidenceRecords.hypothesisId, hypIds))
          .orderBy(asc(evidenceRecords.createdAt), asc(evidenceRecords.id)),
      ])
    : [[], [], []];
  const entityIds = new Set<string>();
  for (const s of seeds) entityIds.add(s.entityId);
  for (const r of relations) {
    entityIds.add(r.fromEntityId);
    entityIds.add(r.toEntityId);
  }
  for (const c of pool) c.elementEntityIds.forEach((id) => entityIds.add(id));
  for (const e of elements) entityIds.add(e.entityId);
  for (const r of latestResolutions)
    if (r.selectedEntityId) entityIds.add(r.selectedEntityId);
  const entityRows = entityIds.size
    ? await db
        .select({
          entity: culturalEntities,
          dataOrigin: toolInvocations.dataOrigin,
          retrievedAt: sourceRetrievedAt,
        })
        .from(culturalEntities)
        .leftJoin(
          toolInvocations,
          eq(toolInvocations.id, culturalEntities.sourceToolInvocationId),
        )
        .where(inArray(culturalEntities.id, [...entityIds]))
    : [];
  const runIds = runs.map((r) => r.id);
  const providers = runIds.length
    ? await db
        .selectDistinct({ provider: llmInvocations.provider })
        .from(llmInvocations)
        .where(inArray(llmInvocations.runId, runIds))
    : [];
  return {
    experiment: {
      id: experiment.id,
      projectId: experiment.projectId,
      briefVersionId: experiment.briefVersionId,
      experimentKey: experiment.experimentKey,
      status: experiment.status,
      mode: experiment.mode,
      kind: experiment.kind,
      createdAt: experiment.createdAt,
      definition: experiment.definition,
    },
    brief: brief[0] ?? null,
    runs,
    llmProviders: providers.map((p) => p.provider),
    resolutions: latestResolutions,
    seeds,
    entities: entityRows.map((e) => ({
      ...e.entity,
      dataOrigin: e.dataOrigin,
      retrievedAt: e.retrievedAt,
    })),
    relations,
    pool,
    hypotheses: hyps.map((h) => ({
      ...h,
      elements: elements.filter((e) => e.hypothesisId === h.id),
      claims: claims.filter((c) => c.hypothesisId === h.id),
      evidence: evidence
        .filter((e) => e.evidence.hypothesisId === h.id)
        .map((e) => ({
          ...e.evidence,
          dataOrigin: e.dataOrigin,
          retrievedAt: e.retrievedAt,
        })),
    })),
  };
}

/** Evidence trace (UI_UX_SPEC §4.4 "Trace"): redacted request, envelope, pointer, rule. */
export async function evidenceTrace(
  db: Executor,
  workspaceId: string,
  evidenceId: string,
) {
  const [row] = await db
    .select({
      evidence: evidenceRecords,
      claim: hypothesisClaims,
      hypothesis: hypotheses,
    })
    .from(evidenceRecords)
    .innerJoin(
      hypothesisClaims,
      eq(hypothesisClaims.id, evidenceRecords.claimId),
    )
    .innerJoin(hypotheses, eq(hypotheses.id, evidenceRecords.hypothesisId))
    .innerJoin(experiments, eq(experiments.id, evidenceRecords.experimentId))
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(
      and(
        eq(evidenceRecords.id, evidenceId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Evidence not found");
  const invocation = row.evidence.toolInvocationId
    ? (
        await db
          .select()
          .from(toolInvocations)
          .where(eq(toolInvocations.id, row.evidence.toolInvocationId))
      )[0]
    : undefined;
  const sourceTime = invocation
    ? ((
        await db
          .select({ retrievedAt: sourceRetrievedAt })
          .from(toolInvocations)
          .where(eq(toolInvocations.id, invocation.id))
      )[0]?.retrievedAt ?? null)
    : null;
  const snapshot = invocation?.snapshotId
    ? (
        await db
          .select({
            rawRetained: qlooResponseSnapshots.rawRetained,
            resultCount: qlooResponseSnapshots.resultCount,
            retrievedAt: qlooResponseSnapshots.retrievedAt,
          })
          .from(qlooResponseSnapshots)
          .where(eq(qlooResponseSnapshots.id, invocation.snapshotId))
      )[0]
    : undefined;
  return {
    evidence: row.evidence,
    claim: {
      id: row.claim.id,
      statement: row.claim.statement,
      testKind: row.claim.testKind,
      testParams: row.claim.testParams,
      status: row.claim.status,
    },
    hypothesis: { id: row.hypothesis.id, title: row.hypothesis.title },
    invocation: invocation
      ? {
          id: invocation.id,
          method: invocation.method,
          workflow: invocation.workflow,
          transport: invocation.transport,
          argsRedacted: invocation.argsRedacted,
          requestHash: invocation.requestHash,
          dataOrigin: invocation.dataOrigin,
          envelopeStatus: invocation.envelopeStatus,
          envelopeShape: invocation.envelopeShape,
          resultCount: invocation.resultCount,
          errorCode: invocation.errorCode,
          correlationId: invocation.correlationId,
          harnessEndpoint: invocation.harnessEndpoint,
          harnessRequests: invocation.harnessRequests,
          latencyMs: invocation.latencyMs,
          attempt: invocation.attempt,
          retrievedAt: sourceTime,
          invokedAt: invocation.createdAt,
        }
      : null,
    snapshot: snapshot ?? null,
  };
}

/** One tool invocation's trace (inspector "Trace"): redacted request and envelope summary. */
export async function invocationTrace(
  db: Executor,
  workspaceId: string,
  invocationId: string,
) {
  const [row] = await db
    .select({ invocation: toolInvocations, retrievedAt: sourceRetrievedAt })
    .from(toolInvocations)
    .innerJoin(projects, eq(projects.id, toolInvocations.projectId))
    .where(
      and(
        eq(toolInvocations.id, invocationId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Invocation not found");
  const i = row.invocation;
  return {
    id: i.id,
    purpose: i.purpose,
    method: i.method,
    workflow: i.workflow,
    transport: i.transport,
    argsRedacted: i.argsRedacted,
    requestHash: i.requestHash,
    dataOrigin: i.dataOrigin,
    cacheSourceInvocationId: i.cacheSourceInvocationId,
    envelopeStatus: i.envelopeStatus,
    envelopeShape: i.envelopeShape,
    resultCount: i.resultCount,
    errorCode: i.errorCode,
    correlationId: i.correlationId,
    harnessEndpoint: i.harnessEndpoint,
    harnessRequests: i.harnessRequests,
    latencyMs: i.latencyMs,
    attempt: i.attempt,
    retrievedAt: row.retrievedAt,
    invokedAt: i.createdAt,
  };
}
