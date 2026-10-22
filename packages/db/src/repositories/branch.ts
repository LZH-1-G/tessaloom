import type { RunAdmission } from "./cost";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  ClaimParams,
  DEFAULT_BUDGETS,
  ExperimentDefinition,
  RunConfig,
  VariableDelta,
  canonicalHash,
  planCounterfactual,
  selectPool,
  uuidv7,
  type CfEntity,
  type CfHypothesis,
  type CompareSide,
  type ComparisonMetrics,
  type CounterfactualPlan,
} from "@tessaloom/core";
import { withPgTx, type DbHandle, type Executor, type Tx } from "../client";
import { DomainRuleError, NotFoundError } from "../errors";
import { enqueueRunStep, type PgBoss } from "../queue";
import {
  agentRuns,
  collisionCandidates,
  counterfactualBranches,
  culturalEntities,
  entityRelations,
  evidenceRecords,
  experimentComparisons,
  experiments,
  hypotheses,
  hypothesisClaims,
  hypothesisElements,
  projects,
  toolInvocations,
} from "../schema";
import {
  appendRunEvents,
  createBranch,
  createRun,
  setExperimentStatus,
} from "./experiment";
import { experimentView } from "./views";

/**
 * Counterfactual branches (AGENT_WORKFLOW §15, ADR-027). The dependency plan is pure
 * (`core/counterfactual`); this module loads its inputs, creates the branch, and materializes
 * the held-fixed copy in one transaction: seeds with the delta applied, the parent's threads
 * and pool (re-selected at the branch tension), hypotheses and claims (re-parameterized), and
 * — for claims whose query and evaluator inputs are unchanged — the parent's evidence through
 * CACHE invocations that link to the original call. Nothing here calls Qloo.
 */

const BRANCHABLE_RUN_STATES = [
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "AWAITING_HYPOTHESIS_SELECTION",
];

export async function counterfactualSource(
  db: Executor,
  workspaceId: string,
  experimentId: string,
) {
  const view = await experimentView(db, workspaceId, experimentId);
  const definition = ExperimentDefinition.parse(view.experiment.definition);
  const parentRun = view.runs[0] ?? null;
  if (!parentRun || !BRANCHABLE_RUN_STATES.includes(parentRun.state))
    throw new DomainRuleError(
      "Branch from an experiment whose hypotheses are final (its run finished or awaits your selection).",
    );
  const entities = new Map<string, CfEntity>(
    view.entities.map((e) => [
      e.id,
      {
        id: e.id,
        qlooId: e.qlooId,
        domain: e.domain,
        kind: e.kind,
        name: e.name,
      },
    ]),
  );
  const hyps: CfHypothesis[] = view.hypotheses
    .filter((h) => !h.retired)
    .map((h) => ({
      id: h.id,
      title: h.title,
      compositeScore: h.compositeScore,
      claims: h.claims.map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        statement: c.statement,
        testKind: c.testKind,
        params: ClaimParams.parse(c.testParams),
        status: c.status,
        stance: c.currentStance,
        evidenceId:
          [...h.evidence].reverse().find((e) => e.claimId === c.id)?.id ?? null,
      })),
    }));
  // The parent's plan date keeps trend windows comparable: only the delta may change a key.
  const today = (parentRun.startedAt ?? parentRun.createdAt)
    .toISOString()
    .slice(0, 10);
  return {
    view,
    definition,
    parentRun,
    entities,
    hypotheses: hyps,
    seeds: view.seeds.map((s) => ({
      entityId: s.entityId,
      role: s.role as "seed" | "location" | "tag_constraint",
    })),
    today,
  };
}

export async function previewCounterfactual(
  db: Executor,
  workspaceId: string,
  experimentId: string,
  delta: unknown,
) {
  const src = await counterfactualSource(db, workspaceId, experimentId);
  const parsed = VariableDelta.parse(delta);
  const plan = planCounterfactual({
    hypotheses: src.hypotheses,
    entities: src.entities,
    seeds: src.seeds,
    variables: src.definition.variables,
    delta: parsed,
    today: src.today,
  });
  return { src, delta: parsed, plan };
}

/** Create (or reuse) a branch and queue its COUNTERFACTUAL run (WI-A5: same delta → same key). */
export async function createCounterfactualBranch(
  handle: DbHandle,
  boss: PgBoss,
  input: {
    workspaceId: string;
    experimentId: string;
    delta: unknown;
    mode: "hold_hypotheses" | "regenerate";
    label?: string | null;
    runConfig: RunConfig;
    admission?: RunAdmission;
  },
) {
  if (input.mode !== "hold_hypotheses")
    throw new DomainRuleError(
      "Regenerate mode is not available yet; hold hypotheses isolates the effect of the change.",
    );
  return withPgTx(handle, async (tx, raw) => {
    const { src, delta, plan } = await previewCounterfactual(
      tx,
      input.workspaceId,
      input.experimentId,
      input.delta,
    );
    if (plan.unsupported.length)
      throw new DomainRuleError(plan.unsupported.join(" "));
    const config = RunConfig.parse(input.runConfig);
    const qlooOf = (id: string) => src.entities.get(id)!.qlooId;
    const kindOf = (id: string): "entity" | "tag" =>
      src.entities.get(id)!.kind === "tag" ? "tag" : "entity";
    const definition = ExperimentDefinition.parse({
      ...src.definition,
      seeds: plan.seeds
        .filter((s) => s.role !== "location")
        .map((s) => ({
          qlooId: qlooOf(s.entityId),
          kind: kindOf(s.entityId),
          role: s.role,
        })),
      variables: plan.variables,
      scoringWeights: delta.scoringWeights ?? src.definition.scoringWeights,
      budgets: DEFAULT_BUDGETS.COUNTERFACTUAL,
      parentExperimentKey: src.view.experiment.experimentKey,
      variableDelta: delta,
    });
    const { experiment, reused } = await createBranch(tx, {
      projectId: src.view.experiment.projectId,
      briefVersionId: src.view.experiment.briefVersionId,
      definition,
      mode: src.view.experiment.mode,
      parentExperimentId: src.view.experiment.id,
      label: input.label ?? null,
      seeds: plan.seeds,
      variableDelta: delta,
      branchMode: input.mode,
      plannedDirtyQueries: plan.dirtyQueries,
      plannedReusedQueries: plan.reusedQueries,
    });
    if (reused) {
      const [latest] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.experimentId, experiment.id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      return {
        branchExperimentId: experiment.id,
        experimentKey: experiment.experimentKey,
        runId: latest?.id ?? null,
        plannedDirtyQueries: plan.dirtyQueries,
        reusedQueries: plan.reusedQueries,
        reused: true,
      };
    }
    const run = await createRun(tx, {
      experimentId: experiment.id,
      kind: "COUNTERFACTUAL",
      budget: DEFAULT_BUDGETS.COUNTERFACTUAL,
      config,
      admission: input.admission,
    });
    await materializeBranch(tx, {
      parentExperimentId: src.view.experiment.id,
      branchExperimentId: experiment.id,
      runId: run.id,
      plan,
    });
    await appendRunEvents(tx, run.id, [
      {
        type: "RUN_STARTED",
        state: "QUEUED",
        summary: "What-if branch started",
        payload: {
          kind: "COUNTERFACTUAL",
          parentExperimentId: src.view.experiment.id,
          deltaHash: canonicalHash(delta),
        },
      },
      { type: "STATE_ENTERED", state: "QUEUED", summary: "Entered QUEUED" },
    ]);
    await setExperimentStatus(tx, experiment.id, "RUNNING");
    await enqueueRunStep(boss, { runId: run.id, expectedStateVersion: 0 }, raw);
    return {
      branchExperimentId: experiment.id,
      experimentKey: experiment.experimentKey,
      runId: run.id,
      plannedDirtyQueries: plan.dirtyQueries,
      reusedQueries: plan.reusedQueries,
      reused: false,
    };
  });
}

async function materializeBranch(
  tx: Tx,
  input: {
    parentExperimentId: string;
    branchExperimentId: string;
    runId: string;
    plan: CounterfactualPlan;
  },
) {
  const { plan } = input;
  // Discovery threads and tags carry over unchanged (same invocations, same provenance).
  const relations = await tx
    .select()
    .from(entityRelations)
    .where(eq(entityRelations.experimentId, input.parentExperimentId));
  if (relations.length)
    await tx.insert(entityRelations).values(
      relations.map((r) => ({
        ...r,
        id: uuidv7(),
        experimentId: input.branchExperimentId,
        createdAt: undefined,
      })),
    );

  // The collision pool carries over and is re-selected at the branch tension.
  const pool = await tx
    .select()
    .from(collisionCandidates)
    .where(eq(collisionCandidates.experimentId, input.parentExperimentId));
  const domainRows = pool.length
    ? await tx
        .select({ id: culturalEntities.id, domain: culturalEntities.domain })
        .from(culturalEntities)
        .where(
          inArray(culturalEntities.id, [
            ...new Set(pool.flatMap((p) => p.elementEntityIds)),
          ]),
        )
    : [];
  const domains = new Map(domainRows.map((d) => [d.id, d.domain ?? "unknown"]));
  const selection = new Map(
    selectPool(
      pool.map((p) => ({
        key: p.elementEntityIds.join("|"),
        elementEntityIds: [p.elementEntityIds[0]!, p.elementEntityIds[1]!] as [
          string,
          string,
        ],
        domains: [
          domains.get(p.elementEntityIds[0]!) ?? "unknown",
          domains.get(p.elementEntityIds[1]!) ?? "unknown",
        ] as [string, string],
        relevance: p.relevance,
        novelty: p.novelty,
      })),
      plan.variables.collisionTension,
    ).map((s) => [s.key, s]),
  );
  const poolIds = new Map<string, string>();
  if (pool.length)
    await tx.insert(collisionCandidates).values(
      pool.map((p) => {
        const id = uuidv7();
        poolIds.set(p.id, id);
        const chosen = selection.get(p.elementEntityIds.join("|"));
        return {
          ...p,
          id,
          experimentId: input.branchExperimentId,
          selected: !!chosen,
          rank: chosen?.rank ?? null,
          tensionFit: Number(
            (1 - Math.abs(p.novelty - plan.variables.collisionTension)).toFixed(
              4,
            ),
          ),
          createdAt: undefined,
        };
      }),
    );

  // Hypotheses are held fixed: same text, lineage, and elements; claims re-parameterized.
  const parentIds = [...new Set(plan.claims.map((c) => c.hypothesisId))];
  const parents = parentIds.length
    ? await tx
        .select()
        .from(hypotheses)
        .where(inArray(hypotheses.id, parentIds))
    : [];
  const parentClaims = parentIds.length
    ? await tx
        .select()
        .from(hypothesisClaims)
        .where(inArray(hypothesisClaims.hypothesisId, parentIds))
    : [];
  const elements = parentIds.length
    ? await tx
        .select()
        .from(hypothesisElements)
        .where(inArray(hypothesisElements.hypothesisId, parentIds))
    : [];
  const reuseClaimIds = plan.claims
    .filter((c) => c.decision === "REUSE")
    .map((c) => c.parentClaimId);
  const parentEvidence = reuseClaimIds.length
    ? await tx
        .select()
        .from(evidenceRecords)
        .where(inArray(evidenceRecords.claimId, reuseClaimIds))
        .orderBy(asc(evidenceRecords.createdAt), asc(evidenceRecords.id))
    : [];
  const cacheInvocation = new Map<string, string>();
  const reuseInvocation = async (parentInvocationId: string) => {
    const known = cacheInvocation.get(parentInvocationId);
    if (known) return known;
    const [orig] = await tx
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, parentInvocationId));
    if (!orig) throw new NotFoundError("Parent invocation not found");
    const id = uuidv7();
    await tx.insert(toolInvocations).values({
      ...orig,
      id,
      runId: input.runId,
      stepSeq: null,
      purpose: `counterfactual reuse of ${orig.purpose}`.slice(0, 200),
      dataOrigin: "CACHE",
      // Always point at the original call, never at another reuse.
      cacheSourceInvocationId: orig.cacheSourceInvocationId ?? orig.id,
      latencyMs: 0,
      createdAt: undefined,
    });
    cacheInvocation.set(parentInvocationId, id);
    return id;
  };

  for (const parent of parents) {
    const id = uuidv7();
    await tx.insert(hypotheses).values({
      ...parent,
      id,
      experimentId: input.branchExperimentId,
      runId: input.runId,
      collisionCandidateId: parent.collisionCandidateId
        ? (poolIds.get(parent.collisionCandidateId) ?? null)
        : null,
      revisionOfId: null,
      inheritedFromId: parent.id,
      iteration: 0,
      retired: false,
      userPinned: false,
      createdAt: undefined,
    });
    await tx
      .insert(hypothesisElements)
      .values(
        elements
          .filter((e) => e.hypothesisId === parent.id)
          .map((e) => ({ ...e, hypothesisId: id })),
      );
    for (const planned of plan.claims.filter(
      (c) => c.hypothesisId === parent.id,
    )) {
      const pc = parentClaims.find((c) => c.id === planned.parentClaimId)!;
      const claimId = uuidv7();
      const status =
        planned.decision === "REUSE"
          ? "TESTED"
          : planned.decision === "INHERIT"
            ? pc.status
            : planned.decision === "DIRTY"
              ? "PLANNED"
              : "UNSUPPORTED";
      await tx.insert(hypothesisClaims).values({
        id: claimId,
        hypothesisId: id,
        ordinal: pc.ordinal,
        statement: pc.statement,
        testKind: pc.testKind,
        testParams: planned.params,
        status,
        currentStance:
          planned.decision === "REUSE" || planned.decision === "INHERIT"
            ? pc.currentStance
            : null,
        dependsOn: [`decision:${planned.decision}`, planned.reason].slice(0, 2),
        queryRequestHash:
          planned.decision === "REUSE" ? pc.queryRequestHash : null,
      });
      if (planned.decision !== "REUSE") continue;
      const latest = [...parentEvidence]
        .reverse()
        .find((e) => e.claimId === pc.id);
      if (!latest?.toolInvocationId) continue;
      await tx.insert(evidenceRecords).values({
        ...latest,
        id: uuidv7(),
        claimId,
        hypothesisId: id,
        experimentId: input.branchExperimentId,
        runId: input.runId,
        toolInvocationId: await reuseInvocation(latest.toolInvocationId),
        // The critic's note was about the parent's evidence set; it is not carried over.
        criticNote: null,
        criticDowngrade: false,
        createdAt: undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Comparisons

/** One side of a comparison, loaded from the database (core `CompareSide`). */
export async function compareSide(
  db: Executor,
  experimentId: string,
): Promise<CompareSide> {
  const hyps = await db
    .select()
    .from(hypotheses)
    .where(eq(hypotheses.experimentId, experimentId))
    .orderBy(asc(hypotheses.createdAt), asc(hypotheses.id));
  const ids = hyps.map((h) => h.id);
  const [claims, evidence] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(hypothesisClaims)
          .where(inArray(hypothesisClaims.hypothesisId, ids))
          .orderBy(asc(hypothesisClaims.ordinal)),
        db
          .select({
            e: evidenceRecords,
            dataOrigin: toolInvocations.dataOrigin,
          })
          .from(evidenceRecords)
          .leftJoin(
            toolInvocations,
            eq(toolInvocations.id, evidenceRecords.toolInvocationId),
          )
          .where(inArray(evidenceRecords.hypothesisId, ids))
          .orderBy(asc(evidenceRecords.createdAt), asc(evidenceRecords.id)),
      ])
    : [[], []];
  const threads = await db
    .select({
      r: entityRelations,
      domain: culturalEntities.domain,
      qlooId: culturalEntities.qlooId,
    })
    .from(entityRelations)
    .innerJoin(
      culturalEntities,
      eq(culturalEntities.id, entityRelations.toEntityId),
    )
    .where(
      and(
        eq(entityRelations.experimentId, experimentId),
        eq(entityRelations.kind, "THREAD"),
      ),
    );
  const invocationIds = [
    ...new Set(threads.map((t) => t.r.toolInvocationIds[0]).filter(Boolean)),
  ] as string[];
  const origins = new Map(
    (invocationIds.length
      ? await db
          .select({ id: toolInvocations.id, o: toolInvocations.dataOrigin })
          .from(toolInvocations)
          .where(inArray(toolInvocations.id, invocationIds))
      : []
    ).map((x) => [x.id, x.o]),
  );
  const grouped = new Map<
    string,
    CompareSide["threads"][number] & { w: number[] }
  >();
  for (const t of threads) {
    const inv = t.r.toolInvocationIds[0] ?? null;
    const key = `${t.r.fromEntityId}|${t.domain}|${inv}`;
    const g = grouped.get(key) ?? {
      seedEntityId: t.r.fromEntityId,
      domain: t.domain ?? "unknown",
      entityIds: [],
      toolInvocationId: inv,
      dataOrigin: inv ? (origins.get(inv) ?? null) : null,
      w: [],
    };
    g.entityIds.push(t.qlooId);
    g.w.push(t.r.weight ?? 0);
    grouped.set(key, g);
  }
  return {
    experimentId,
    hypotheses: hyps.map((h) => ({
      id: h.id,
      lineageId: h.lineageId,
      title: h.title,
      status: h.status,
      retired: h.retired,
      compositeScore: h.compositeScore,
      supportScore: h.supportScore,
      noveltyScore: h.noveltyScore,
      feasibilityScore: h.feasibilityScore,
      claims: claims
        .filter((c) => c.hypothesisId === h.id)
        .map((c) => ({
          id: c.id,
          ordinal: c.ordinal,
          statement: c.statement,
          testKind: c.testKind,
          status: c.status,
          currentStance: c.currentStance,
        })),
      evidence: evidence
        .filter((x) => x.e.hypothesisId === h.id)
        .map((x) => ({
          id: x.e.id,
          claimId: x.e.claimId,
          stance: x.e.stance,
          toolInvocationId: x.e.toolInvocationId,
          dataOrigin: x.dataOrigin,
          resultIds: x.e.resultIds,
        })),
    })),
    threads: [...grouped.values()].map(({ w, ...t }) => ({
      ...t,
      // Higher weight = better rank (weight = 1 − position / k).
      entityIds: t.entityIds
        .map((id, i) => ({ id, w: w[i]! }))
        .sort((a, b) => b.w - a.w)
        .map((x) => x.id),
    })),
  };
}

export async function branchRecord(db: Executor, branchExperimentId: string) {
  const [row] = await db
    .select()
    .from(counterfactualBranches)
    .where(eq(counterfactualBranches.branchExperimentId, branchExperimentId));
  return row ?? null;
}

/** Upsert a comparison (recomputing metrics replaces the row for the same version). */
export async function saveComparison(
  tx: Executor,
  input: {
    projectId: string;
    baseExperimentId: string;
    otherExperimentId: string;
    kind: "COUNTERFACTUAL" | "DATA_DRIFT" | "AD_HOC";
    metrics: ComparisonMetrics;
    narrative: Record<string, unknown> | null;
  },
) {
  const [row] = await tx
    .insert(experimentComparisons)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      baseExperimentId: input.baseExperimentId,
      otherExperimentId: input.otherExperimentId,
      comparisonKind: input.kind,
      metrics: input.metrics,
      dirtyQueries: input.metrics.header.dirtyQueries,
      reusedQueries: input.metrics.header.reusedQueries,
      newQlooResults: input.metrics.header.newQlooResults,
      narrative: input.narrative,
      metricsVersion: input.metrics.version,
    })
    .onConflictDoUpdate({
      target: [
        experimentComparisons.baseExperimentId,
        experimentComparisons.otherExperimentId,
        experimentComparisons.metricsVersion,
      ],
      set: {
        metrics: input.metrics,
        dirtyQueries: input.metrics.header.dirtyQueries,
        reusedQueries: input.metrics.header.reusedQueries,
        newQlooResults: input.metrics.header.newQlooResults,
        narrative: input.narrative,
      },
    })
    .returning();
  return row!;
}

export async function getComparison(
  db: Executor,
  workspaceId: string,
  comparisonId: string,
) {
  const [row] = await db
    .select({ c: experimentComparisons })
    .from(experimentComparisons)
    .innerJoin(projects, eq(projects.id, experimentComparisons.projectId))
    .where(
      and(
        eq(experimentComparisons.id, comparisonId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Comparison not found");
  return row.c;
}

export async function findComparison(
  db: Executor,
  baseExperimentId: string,
  otherExperimentId: string,
) {
  const [row] = await db
    .select()
    .from(experimentComparisons)
    .where(
      and(
        eq(experimentComparisons.baseExperimentId, baseExperimentId),
        eq(experimentComparisons.otherExperimentId, otherExperimentId),
      ),
    )
    .orderBy(desc(experimentComparisons.createdAt))
    .limit(1);
  return row ?? null;
}

/** Branches of an experiment tree, with their delta, plan counts, and latest run. */
export async function listBranches(
  db: Executor,
  workspaceId: string,
  experimentId: string,
) {
  const [root] = await db
    .select({ e: experiments })
    .from(experiments)
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(
      and(
        eq(experiments.id, experimentId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!root) throw new NotFoundError("Experiment not found");
  const rootId = root.e.rootExperimentId ?? root.e.id;
  const rows = await db
    .select({ e: experiments, b: counterfactualBranches })
    .from(experiments)
    .leftJoin(
      counterfactualBranches,
      eq(counterfactualBranches.branchExperimentId, experiments.id),
    )
    .where(eq(experiments.rootExperimentId, rootId))
    .orderBy(asc(experiments.createdAt));
  const ids = rows.map((r) => r.e.id);
  const runs = ids.length
    ? await db
        .select()
        .from(agentRuns)
        .where(inArray(agentRuns.experimentId, ids))
        .orderBy(desc(agentRuns.createdAt))
    : [];
  const comps = ids.length
    ? await db
        .select({
          id: experimentComparisons.id,
          base: experimentComparisons.baseExperimentId,
          other: experimentComparisons.otherExperimentId,
        })
        .from(experimentComparisons)
        .where(inArray(experimentComparisons.otherExperimentId, ids))
    : [];
  return rows.map(({ e, b }) => ({
    id: e.id,
    kind: e.kind,
    label: e.label,
    parentExperimentId: e.parentExperimentId,
    status: e.status,
    createdAt: e.createdAt,
    variableDelta: b?.variableDelta ?? null,
    plannedDirtyQueries: b?.plannedDirtyQueries ?? null,
    plannedReusedQueries: b?.plannedReusedQueries ?? null,
    latestRun: runs.find((r) => r.experimentId === e.id) ?? null,
    comparisonId:
      comps.find((c) => c.other === e.id && c.base === e.parentExperimentId)
        ?.id ?? null,
  }));
}
