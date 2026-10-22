import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "@tessaloom/core";
import type { Executor, Tx } from "../client";
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
  projects,
  runEvents,
} from "../schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One bound parameter holding a Postgres uuid[] literal (drizzle expands JS arrays). */
export function uuidArray(ids: string[]) {
  for (const id of ids) if (!UUID.test(id)) throw new Error("Invalid uuid");
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

// --- Resolution (latest record per interest of a brief version) ---

export async function latestResolutions(db: Executor, briefVersionId: string) {
  const rows = await db
    .select()
    .from(entityResolutionRecords)
    .where(eq(entityResolutionRecords.briefVersionId, briefVersionId))
    .orderBy(
      asc(entityResolutionRecords.interestIndex),
      desc(entityResolutionRecords.createdAt),
      desc(entityResolutionRecords.id),
    );
  const seen = new Set<number>();
  return rows.filter((r) => {
    const key = r.interestIndex ?? -1;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Seeds, entities, relations, collision pool ---

export async function insertExperimentSeeds(
  tx: Executor,
  experimentId: string,
  seeds: { entityId: string; role: "seed" | "tag_constraint" | "location" }[],
) {
  if (seeds.length === 0) return;
  await tx
    .insert(experimentSeeds)
    .values(
      seeds.map((s, ordinal) => ({
        experimentId,
        entityId: s.entityId,
        role: s.role,
        ordinal,
      })),
    )
    .onConflictDoNothing();
}

export async function listSeedEntities(db: Executor, experimentId: string) {
  return db
    .select({ seed: experimentSeeds, entity: culturalEntities })
    .from(experimentSeeds)
    .innerJoin(
      culturalEntities,
      eq(culturalEntities.id, experimentSeeds.entityId),
    )
    .where(eq(experimentSeeds.experimentId, experimentId))
    .orderBy(asc(experimentSeeds.ordinal));
}

export async function getEntities(db: Executor, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(culturalEntities)
    .where(inArray(culturalEntities.id, ids));
}

export async function insertRelations(
  tx: Executor,
  rows: Omit<typeof entityRelations.$inferInsert, "id">[],
) {
  if (rows.length === 0) return [];
  return tx
    .insert(entityRelations)
    .values(rows.map((r) => ({ ...r, id: uuidv7() })))
    .returning();
}

export async function listRelations(db: Executor, experimentId: string) {
  return db
    .select()
    .from(entityRelations)
    .where(eq(entityRelations.experimentId, experimentId));
}

export async function insertCollisionCandidates(
  tx: Executor,
  rows: Omit<typeof collisionCandidates.$inferInsert, "id">[],
) {
  if (rows.length === 0) return [];
  return tx
    .insert(collisionCandidates)
    .values(rows.map((r) => ({ ...r, id: uuidv7() })))
    .returning();
}

export async function updateCollisionCandidate(
  db: Executor,
  id: string,
  patch: { selected: boolean; rank: number | null; tensionFit: number },
) {
  await db
    .update(collisionCandidates)
    .set(patch)
    .where(eq(collisionCandidates.id, id));
}

export async function listCollisionCandidates(
  db: Executor,
  experimentId: string,
) {
  return db
    .select()
    .from(collisionCandidates)
    .where(eq(collisionCandidates.experimentId, experimentId))
    .orderBy(asc(collisionCandidates.rank));
}

// --- Hypothesis loop state ---

export async function listHypothesisState(db: Executor, experimentId: string) {
  const hyps = await db
    .select()
    .from(hypotheses)
    .where(eq(hypotheses.experimentId, experimentId))
    .orderBy(asc(hypotheses.createdAt), asc(hypotheses.id));
  const ids = hyps.map((h) => h.id);
  if (ids.length === 0) return [];
  const [elements, claims, evidence] = await Promise.all([
    db
      .select()
      .from(hypothesisElements)
      .where(inArray(hypothesisElements.hypothesisId, ids)),
    db
      .select()
      .from(hypothesisClaims)
      .where(inArray(hypothesisClaims.hypothesisId, ids))
      .orderBy(asc(hypothesisClaims.ordinal)),
    db
      .select({
        id: evidenceRecords.id,
        claimId: evidenceRecords.claimId,
        hypothesisId: evidenceRecords.hypothesisId,
        stance: evidenceRecords.stance,
        toolInvocationId: evidenceRecords.toolInvocationId,
        evaluatorId: evidenceRecords.evaluatorId,
        rationale: evidenceRecords.rationale,
        provenanceClass: evidenceRecords.provenanceClass,
        createdAt: evidenceRecords.createdAt,
      })
      .from(evidenceRecords)
      .where(inArray(evidenceRecords.hypothesisId, ids))
      .orderBy(asc(evidenceRecords.createdAt)),
  ]);
  return hyps.map((h) => ({
    ...h,
    elements: elements.filter((e) => e.hypothesisId === h.id),
    claims: claims.filter((c) => c.hypothesisId === h.id),
    evidence: evidence.filter((e) => e.hypothesisId === h.id),
  }));
}

export async function updateHypothesis(
  db: Executor,
  id: string,
  patch: Partial<
    Pick<
      typeof hypotheses.$inferInsert,
      | "status"
      | "supportScore"
      | "noveltyScore"
      | "feasibilityScore"
      | "compositeScore"
      | "scoreBreakdown"
      | "retired"
      | "userPinned"
    >
  >,
) {
  await db.update(hypotheses).set(patch).where(eq(hypotheses.id, id));
}

// --- Maintenance queries ---

const PAUSED = sql`${agentRuns.state} IN ('AWAITING_BRIEF_CONFIRMATION','AWAITING_ENTITY_CONFIRMATION','AWAITING_POOL_CONFIRMATION','AWAITING_HYPOTHESIS_SELECTION','AWAITING_COUNTERFACTUAL_CONFIRMATION')`;
const TERMINAL = sql`${agentRuns.state} IN ('COMPLETED','COMPLETED_WITH_LIMITS','FAILED','CANCELLED')`;

const lastEventTs = sql<Date>`(SELECT max(${runEvents.ts}) FROM ${runEvents} WHERE ${runEvents.runId} = ${agentRuns.id})`;

/** Paused runs whose last event is older than the cutoff (AGENT_WORKFLOW §4: 24 h expiry). */
export async function listExpiredPausedRuns(db: Executor, cutoff: Date) {
  return db
    .select({ id: agentRuns.id, stateVersion: agentRuns.stateVersion })
    .from(agentRuns)
    .where(and(PAUSED, sql`${lastEventTs} < ${cutoff.toISOString()}`));
}

/** Runnable runs with no activity since the cutoff: candidates for re-enqueueing. */
export async function listStalledRuns(db: Executor, cutoff: Date) {
  return db
    .select({ id: agentRuns.id, stateVersion: agentRuns.stateVersion })
    .from(agentRuns)
    .where(
      and(
        sql`NOT (${PAUSED})`,
        sql`NOT (${TERMINAL})`,
        sql`coalesce(${lastEventTs}, ${agentRuns.createdAt}) < ${cutoff.toISOString()}`,
      ),
    );
}

export type HypothesisState = Awaited<
  ReturnType<typeof listHypothesisState>
>[number];

/** Lock helper for confirmations (DATABASE_SCHEMA §6 "Confirmation"). */
export async function lockRun(tx: Tx, runId: string) {
  const [row] = await tx
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  return row ?? null;
}

/**
 * Everything a step handler reads, in one consistent snapshot (READ COMMITTED reads outside
 * any transaction; the commit later re-checks `state_version` under a row lock).
 */
export async function loadRunSnapshot(db: Executor, runId: string) {
  const [row] = await db
    .select({ run: agentRuns, experiment: experiments, project: projects })
    .from(agentRuns)
    .innerJoin(experiments, eq(experiments.id, agentRuns.experimentId))
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(eq(agentRuns.id, runId));
  if (!row) return null;
  const { run, experiment, project } = row;
  const [brief] = await db
    .select()
    .from(briefVersions)
    .where(eq(briefVersions.id, experiment.briefVersionId));
  const [resolutions, seeds, relations, pool, hyps, stateEvents] =
    await Promise.all([
      latestResolutions(db, experiment.briefVersionId),
      listSeedEntities(db, experiment.id),
      db
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.experimentId, experiment.id),
            inArray(entityRelations.kind, ["THREAD", "HAS_TAG"]),
          ),
        ),
      db
        .select()
        .from(collisionCandidates)
        .where(eq(collisionCandidates.experimentId, experiment.id))
        .orderBy(asc(collisionCandidates.rank), asc(collisionCandidates.id)),
      listHypothesisState(db, experiment.id),
      db
        .select({ state: runEvents.state, ts: runEvents.ts })
        .from(runEvents)
        .where(
          and(eq(runEvents.runId, runId), eq(runEvents.type, "STATE_ENTERED")),
        )
        .orderBy(asc(runEvents.seq)),
    ]);
  const referenced = new Set<string>();
  for (const r of resolutions)
    if (r.selectedEntityId) referenced.add(r.selectedEntityId);
  for (const r of relations) {
    referenced.add(r.fromEntityId);
    referenced.add(r.toEntityId);
  }
  for (const c of pool) c.elementEntityIds.forEach((id) => referenced.add(id));
  for (const h of hyps) {
    h.elements.forEach((e) => referenced.add(e.entityId));
    for (const c of h.claims) {
      const p = c.testParams as Record<string, unknown>;
      for (const key of [
        "signalEntityIds",
        "tagEntityIds",
        "optionEntityIds",
        "compareEntityIds",
      ])
        for (const id of (p[key] as string[] | undefined) ?? [])
          if (UUID.test(id)) referenced.add(id);
      if (typeof p.targetEntityId === "string" && UUID.test(p.targetEntityId))
        referenced.add(p.targetEntityId);
    }
  }
  const entities = [
    ...seeds.map((s) => s.entity),
    ...(await getEntities(db, [...referenced])),
  ];
  return {
    run,
    experiment,
    workspaceId: project.workspaceId,
    brief: brief!,
    resolutions,
    seeds: seeds.map((s) => ({ ...s.entity, role: s.seed.role })),
    entities,
    threads: relations.filter((r) => r.kind === "THREAD"),
    hasTag: relations.filter((r) => r.kind === "HAS_TAG"),
    pool,
    hypotheses: hyps,
    stateEvents,
  };
}
