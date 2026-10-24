import { sourceRetrievedAt } from "./qloo";
import type { RunAdmission } from "./cost";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  BlueprintContent,
  DEFAULT_BUDGETS,
  RunConfig,
  blueprintMarkdown,
  citationOrder,
  isTerminal,
  normalizeUserRevision,
  traceabilityReport,
  type AppendixEntry,
  type BlueprintContent as BlueprintContentT,
  type RunState,
  type TraceabilityReport,
} from "@tessaloom/core";
import {
  withPgTx,
  withTx,
  type DbHandle,
  type Executor,
  type Tx,
} from "../client";
import { DomainRuleError, NotFoundError, StateConflictError } from "../errors";
import { enqueueRunStep, type PgBoss } from "../queue";
import {
  agentRuns,
  blueprintRevisions,
  evidenceRecords,
  experienceBlueprints,
  experiments,
  hypotheses,
  hypothesisClaims,
  projects,
  shareLinks,
  toolInvocations,
} from "../schema";
import { appendRunEvents, createRun, setExperimentStatus } from "./experiment";
import {
  addBlueprintRevision,
  createBlueprint,
  createShareLink,
  findActiveShareLink,
  revokeShareLink,
} from "./ops";
import { experimentView } from "./views";

/**
 * Experience Blueprints (PRD §6.6, API_CONTRACTS §4.6, ADR-028): composition runs, append-only
 * revisions with server-decided provenance, exports with an evidence appendix, and read-only
 * share links (SECURITY §4.3). Every read is workspace-scoped; share reads are token-scoped.
 */

/** The experiment's hypotheses must be final and no other run may be active. */
async function assertComposable(db: Executor, experimentId: string) {
  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.experimentId, experimentId))
    .orderBy(desc(agentRuns.createdAt));
  const active = runs.find((r) => !isTerminal(r.state as RunState));
  if (active)
    throw new StateConflictError(
      active.state === "AWAITING_HYPOTHESIS_SELECTION"
        ? "Record your hypothesis selection first."
        : "Another run is still working on this experiment.",
    );
  const source = runs.find(
    (r) => r.kind === "EXPLORATION" || r.kind === "COUNTERFACTUAL",
  );
  if (!source || !["COMPLETED", "COMPLETED_WITH_LIMITS"].includes(source.state))
    throw new DomainRuleError(
      "Compose from an experiment whose hypothesis loop has finished.",
    );
}

async function ownedExperiment(
  db: Executor,
  workspaceId: string,
  experimentId: string,
) {
  const [row] = await db
    .select({ e: experiments })
    .from(experiments)
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(
      and(
        eq(experiments.id, experimentId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Experiment not found");
  return row.e;
}

export async function ownedBlueprint(
  db: Executor,
  workspaceId: string,
  blueprintId: string,
) {
  const [row] = await db
    .select({ b: experienceBlueprints })
    .from(experienceBlueprints)
    .innerJoin(projects, eq(projects.id, experienceBlueprints.projectId))
    .where(
      and(
        eq(experienceBlueprints.id, blueprintId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Blueprint not found");
  return row.b;
}

async function queueComposition(
  tx: Tx,
  raw: Parameters<typeof enqueueRunStep>[2],
  boss: PgBoss,
  input: {
    experimentId: string;
    blueprintId: string;
    runConfig: RunConfig;
    summary: string;
    payload: Record<string, unknown>;
    admission?: RunAdmission;
  },
) {
  const run = await createRun(tx, {
    experimentId: input.experimentId,
    kind: "COMPOSITION",
    budget: DEFAULT_BUDGETS.COMPOSITION,
    config: RunConfig.parse(input.runConfig),
    blueprintId: input.blueprintId,
    admission: input.admission,
  });
  await appendRunEvents(tx, run.id, [
    {
      type: "RUN_STARTED",
      state: "QUEUED",
      summary: input.summary,
      payload: { kind: "COMPOSITION", ...input.payload },
    },
    { type: "STATE_ENTERED", state: "QUEUED", summary: "Entered QUEUED" },
  ]);
  await setExperimentStatus(tx, input.experimentId, "RUNNING");
  await enqueueRunStep(boss, { runId: run.id, expectedStateVersion: 0 }, raw);
  return run;
}

/** POST /experiments/:id/blueprints — a COMPOSITION run for 1–3 selected hypotheses. */
export async function startComposition(
  handle: DbHandle,
  boss: PgBoss,
  input: {
    workspaceId: string;
    experimentId: string;
    hypothesisIds: string[];
    format: "event" | "series" | "installation";
    runConfig: RunConfig;
    admission?: RunAdmission;
  },
) {
  const ids = [...new Set(input.hypothesisIds)];
  if (ids.length < 1 || ids.length > 3)
    throw new DomainRuleError("Select 1–3 hypotheses to compose a blueprint.");
  return withPgTx(handle, async (tx, raw) => {
    const experiment = await ownedExperiment(
      tx,
      input.workspaceId,
      input.experimentId,
    );
    await assertComposable(tx, experiment.id);
    const rows = await tx
      .select({ id: hypotheses.id })
      .from(hypotheses)
      .where(
        and(
          eq(hypotheses.experimentId, experiment.id),
          eq(hypotheses.retired, false),
          inArray(hypotheses.id, ids),
        ),
      );
    if (rows.length !== ids.length)
      throw new DomainRuleError("Unknown or retired hypothesis");
    const blueprint = await createBlueprint(tx, {
      projectId: experiment.projectId,
      experimentId: experiment.id,
      hypothesisIds: ids,
      format: input.format,
    });
    const run = await queueComposition(tx, raw, boss, {
      experimentId: experiment.id,
      blueprintId: blueprint.id,
      runConfig: input.runConfig,
      admission: input.admission,
      summary: "Blueprint composition started",
      payload: { blueprintId: blueprint.id, hypotheses: ids.length },
    });
    return { blueprintId: blueprint.id, runId: run.id };
  });
}

/** POST /blueprints/:id/sections/:kind/recompose — one section, optional instruction. */
export async function startRecompose(
  handle: DbHandle,
  boss: PgBoss,
  input: {
    workspaceId: string;
    blueprintId: string;
    section: string;
    instruction: string | null;
    runConfig: RunConfig;
    admission?: RunAdmission;
  },
) {
  return withPgTx(handle, async (tx, raw) => {
    const bp = await ownedBlueprint(tx, input.workspaceId, input.blueprintId);
    if (!bp.currentRevisionId)
      throw new StateConflictError("The blueprint has no revision yet.");
    await assertComposable(tx, bp.experimentId);
    await tx
      .update(experienceBlueprints)
      .set({
        draftContent: null,
        draftMeta: {
          repairAttempts: 0,
          issues: [],
          recompose: { section: input.section, instruction: input.instruction },
        },
      })
      .where(eq(experienceBlueprints.id, bp.id));
    const run = await queueComposition(tx, raw, boss, {
      experimentId: bp.experimentId,
      blueprintId: bp.id,
      runConfig: input.runConfig,
      admission: input.admission,
      summary: `Recomposing the ${input.section} section`,
      payload: { blueprintId: bp.id, section: input.section },
    });
    return { runId: run.id };
  });
}

/** The worker's view of the blueprint a COMPOSITION run works on. */
export async function blueprintForRun(db: Executor, blueprintId: string) {
  const [bp] = await db
    .select()
    .from(experienceBlueprints)
    .where(eq(experienceBlueprints.id, blueprintId));
  if (!bp) return null;
  const [current] = bp.currentRevisionId
    ? await db
        .select()
        .from(blueprintRevisions)
        .where(eq(blueprintRevisions.id, bp.currentRevisionId))
    : [];
  const meta = (bp.draftMeta ?? {}) as {
    repairAttempts?: number;
    issues?: string[];
    recompose?: { section: string; instruction: string | null } | null;
  };
  return {
    id: bp.id,
    format: bp.format,
    hypothesisIds: bp.hypothesisIds,
    draft: (bp.draftContent as BlueprintContentT | null) ?? null,
    repairAttempts: meta.repairAttempts ?? 0,
    issues: meta.issues ?? [],
    recompose: meta.recompose ?? null,
    base: (current?.content as BlueprintContentT | undefined) ?? null,
    baseRevisionId: current?.id ?? null,
  };
}

/** Worker commit: keep the draft between COMPOSING and VALIDATING, or append the revision. */
export async function commitBlueprint(
  tx: Tx,
  input: {
    blueprintId: string;
    runId: string;
    draft?: BlueprintContentT | null;
    draftMeta?: Record<string, unknown> | null;
    revision?: {
      content: BlueprintContentT;
      traceabilityReport: Record<string, unknown>;
      changeSummary: string;
    };
  },
) {
  if (input.revision) {
    const [bp] = await tx
      .select({ current: experienceBlueprints.currentRevisionId })
      .from(experienceBlueprints)
      .where(eq(experienceBlueprints.id, input.blueprintId));
    await addBlueprintRevision(tx, {
      blueprintId: input.blueprintId,
      baseRevisionId: bp?.current ?? null,
      author: "AGENT",
      runId: input.runId,
      content: input.revision.content,
      traceabilityReport: input.revision.traceabilityReport,
      changeSummary: input.revision.changeSummary,
    });
  }
  if (input.draft !== undefined || input.draftMeta !== undefined)
    await tx
      .update(experienceBlueprints)
      .set({
        ...(input.draft !== undefined ? { draftContent: input.draft } : {}),
        ...(input.draftMeta !== undefined
          ? { draftMeta: input.draftMeta }
          : {}),
      })
      .where(eq(experienceBlueprints.id, input.blueprintId));
}

// ---------------------------------------------------------------------------
// Read models

async function experimentEvidenceIds(db: Executor, experimentId: string) {
  const rows = await db
    .select({ id: evidenceRecords.id })
    .from(evidenceRecords)
    .where(eq(evidenceRecords.experimentId, experimentId));
  return new Set(rows.map((r) => r.id));
}

/** Evidence appendix for a revision, labeled E-1… in order of first citation. */
/**
 * The original call behind each CACHE invocation (following chains, e.g. a branch of a
 * branch), so reused fixture data stays labeled as fixture data with its first retrieval date.
 */
async function cacheSources(db: Executor, invocationIds: string[]) {
  const out = new Map<string, { dataOrigin: string; createdAt: Date }>();
  let pending = new Map(invocationIds.map((id) => [id, id])); // current hop → start
  for (let hop = 0; pending.size && hop < 10; hop++) {
    const rows = await db
      .select({
        id: toolInvocations.id,
        dataOrigin: toolInvocations.dataOrigin,
        source: toolInvocations.cacheSourceInvocationId,
        createdAt: toolInvocations.createdAt,
      })
      .from(toolInvocations)
      .where(inArray(toolInvocations.id, [...pending.keys()]));
    const next = new Map<string, string>();
    for (const row of rows) {
      const start = pending.get(row.id)!;
      if (row.dataOrigin === "CACHE" && row.source) next.set(row.source, start);
      else out.set(start, row);
    }
    pending = next;
  }
  return out;
}

export async function evidenceAppendix(
  db: Executor,
  content: BlueprintContentT,
): Promise<AppendixEntry[]> {
  const order = citationOrder(content);
  if (!order.length) return [];
  const rows = await db
    .select({
      e: evidenceRecords,
      claim: hypothesisClaims.statement,
      hypothesisTitle: hypotheses.title,
      dataOrigin: toolInvocations.dataOrigin,
      retrievedAt: sourceRetrievedAt,
    })
    .from(evidenceRecords)
    .innerJoin(
      hypothesisClaims,
      eq(hypothesisClaims.id, evidenceRecords.claimId),
    )
    .innerJoin(hypotheses, eq(hypotheses.id, evidenceRecords.hypothesisId))
    .leftJoin(
      toolInvocations,
      eq(toolInvocations.id, evidenceRecords.toolInvocationId),
    )
    .where(inArray(evidenceRecords.id, order));
  const by = new Map(rows.map((r) => [r.e.id, r]));
  const sources = await cacheSources(
    db,
    rows
      .filter((r) => r.dataOrigin === "CACHE")
      .map((r) => r.e.toolInvocationId!),
  );
  return order
    .filter((id) => by.has(id))
    .map((id, i) => {
      const r = by.get(id)!;
      const source =
        r.dataOrigin === "CACHE"
          ? sources.get(r.e.toolInvocationId!)
          : undefined;
      const retrievedAt = r.retrievedAt;
      return {
        id,
        label: `E-${i + 1}`,
        hypothesisTitle: r.hypothesisTitle,
        claim: r.claim,
        stance: r.e.stance,
        rationale: r.e.rationale,
        evaluatorId: r.e.evaluatorId,
        rulesetVersion: r.e.rulesetVersion,
        provenanceClass: r.e.provenanceClass,
        dataOrigin: source ? source.dataOrigin : r.dataOrigin,
        reused: r.dataOrigin === "CACHE",
        retrievedAt: retrievedAt?.toISOString().slice(0, 10) ?? null,
        toolInvocationId: r.e.toolInvocationId,
      };
    });
}

async function blueprintDetail(
  db: Executor,
  bp: typeof experienceBlueprints.$inferSelect,
) {
  const [revisions, hyps, runs, experiment] = await Promise.all([
    db
      .select({
        id: blueprintRevisions.id,
        revisionNumber: blueprintRevisions.revisionNumber,
        author: blueprintRevisions.author,
        changeSummary: blueprintRevisions.changeSummary,
        contentHash: blueprintRevisions.contentHash,
        createdAt: blueprintRevisions.createdAt,
      })
      .from(blueprintRevisions)
      .where(eq(blueprintRevisions.blueprintId, bp.id))
      .orderBy(desc(blueprintRevisions.revisionNumber)),
    db
      .select({
        id: hypotheses.id,
        title: hypotheses.title,
        status: hypotheses.status,
      })
      .from(hypotheses)
      .where(inArray(hypotheses.id, bp.hypothesisIds)),
    db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.blueprintId, bp.id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1),
    db
      .select({
        id: experiments.id,
        kind: experiments.kind,
        label: experiments.label,
      })
      .from(experiments)
      .where(eq(experiments.id, bp.experimentId)),
  ]);
  const [current] = bp.currentRevisionId
    ? await db
        .select()
        .from(blueprintRevisions)
        .where(eq(blueprintRevisions.id, bp.currentRevisionId))
    : [];
  return {
    blueprint: {
      id: bp.id,
      projectId: bp.projectId,
      experimentId: bp.experimentId,
      hypothesisIds: bp.hypothesisIds,
      format: bp.format,
      status: bp.status,
      currentRevisionId: bp.currentRevisionId,
      createdAt: bp.createdAt,
      updatedAt: bp.updatedAt,
    },
    experiment: experiment[0] ?? null,
    hypotheses: bp.hypothesisIds
      .map((id) => hyps.find((h) => h.id === id))
      .filter(Boolean),
    current: current ?? null,
    appendix: current
      ? await evidenceAppendix(db, current.content as BlueprintContentT)
      : [],
    revisions,
    latestRun: runs[0] ?? null,
  };
}

export async function blueprintView(
  db: Executor,
  workspaceId: string,
  blueprintId: string,
) {
  return blueprintDetail(
    db,
    await ownedBlueprint(db, workspaceId, blueprintId),
  );
}

export async function listBlueprints(
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
  const rows = await db
    .select({
      b: experienceBlueprints,
      title: sql<string | null>`${blueprintRevisions.content}->>'title'`,
      revisionNumber: blueprintRevisions.revisionNumber,
    })
    .from(experienceBlueprints)
    .leftJoin(
      blueprintRevisions,
      eq(blueprintRevisions.id, experienceBlueprints.currentRevisionId),
    )
    .where(eq(experienceBlueprints.projectId, projectId))
    .orderBy(desc(experienceBlueprints.updatedAt));
  return rows.map((r) => ({
    id: r.b.id,
    experimentId: r.b.experimentId,
    format: r.b.format,
    status: r.b.status,
    title: r.title,
    revisionNumber: r.revisionNumber,
    updatedAt: r.b.updatedAt,
  }));
}

export async function getRevision(
  db: Executor,
  workspaceId: string,
  blueprintId: string,
  revisionId: string,
) {
  await ownedBlueprint(db, workspaceId, blueprintId);
  const [rev] = await db
    .select()
    .from(blueprintRevisions)
    .where(
      and(
        eq(blueprintRevisions.id, revisionId),
        eq(blueprintRevisions.blueprintId, blueprintId),
      ),
    );
  if (!rev) throw new NotFoundError("Revision not found");
  return {
    revision: rev,
    appendix: await evidenceAppendix(db, rev.content as BlueprintContentT),
  };
}

/** POST /blueprints/:id/revisions — a user edit, normalized by the server (EB-A3). */
export async function saveUserRevision(
  handle: DbHandle,
  input: {
    workspaceId: string;
    blueprintId: string;
    baseRevisionId: string;
    content: unknown;
    restoreOf?: number | null;
  },
) {
  return withTx(handle.db, async (tx) => {
    const bp = await ownedBlueprint(tx, input.workspaceId, input.blueprintId);
    if (bp.currentRevisionId !== input.baseRevisionId)
      throw new StateConflictError(
        "The blueprint changed since you opened it.",
      );
    const [base] = await tx
      .select()
      .from(blueprintRevisions)
      .where(eq(blueprintRevisions.id, input.baseRevisionId));
    const ids = await experimentEvidenceIds(tx, bp.experimentId);
    let content: BlueprintContentT;
    let summary: string;
    if (input.restoreOf) {
      // A restore reproduces the stored revision verbatim (its provenance was decided then);
      // the client's copy is ignored, so a restore can never smuggle in forged provenance.
      const [old] = await tx
        .select()
        .from(blueprintRevisions)
        .where(
          and(
            eq(blueprintRevisions.blueprintId, bp.id),
            eq(blueprintRevisions.revisionNumber, input.restoreOf),
          ),
        );
      if (!old) throw new NotFoundError("Revision not found");
      if (old.contentHash === base!.contentHash)
        throw new DomainRuleError("That revision is already current.");
      content = old.content as BlueprintContentT;
      summary = `Restored revision ${input.restoreOf}`;
    } else {
      const normalized = normalizeUserRevision(
        base!.content as BlueprintContentT,
        BlueprintContent.parse(input.content),
        ids,
      );
      if (normalized.issues.length)
        throw new DomainRuleError(normalized.issues.slice(0, 3).join("; "));
      if (!normalized.changed) throw new DomainRuleError("Nothing changed.");
      content = normalized.content;
      summary = `Edited by you (${normalized.changed} change${normalized.changed === 1 ? "" : "s"})`;
    }
    const report = traceabilityReport(content, ids);
    if (report.unresolved.length)
      throw new DomainRuleError(
        "Every citation must resolve to this experiment's evidence.",
      );
    const revision = await addBlueprintRevision(tx, {
      blueprintId: bp.id,
      baseRevisionId: input.baseRevisionId,
      author: "USER",
      content,
      traceabilityReport: report as unknown as Record<string, unknown>,
      changeSummary: summary,
    });
    if (bp.status === "ACCEPTED")
      await tx
        .update(experienceBlueprints)
        .set({ status: "DRAFT" })
        .where(eq(experienceBlueprints.id, bp.id));
    return revision;
  });
}

export async function setBlueprintStatus(
  db: Executor,
  workspaceId: string,
  blueprintId: string,
  status: "DRAFT" | "ACCEPTED",
) {
  const bp = await ownedBlueprint(db, workspaceId, blueprintId);
  if (!bp.currentRevisionId)
    throw new StateConflictError("The blueprint has no revision yet.");
  await db
    .update(experienceBlueprints)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(experienceBlueprints.id, blueprintId));
}

/** Export (EB-5): Markdown with the evidence appendix, or JSON with the same appendix. */
export async function exportBlueprint(
  db: Executor,
  scope: { workspaceId: string } | { shareBlueprintId: string },
  blueprintId: string,
  format: "md" | "json",
) {
  const bp =
    "workspaceId" in scope
      ? await ownedBlueprint(db, scope.workspaceId, blueprintId)
      : (
          await db
            .select()
            .from(experienceBlueprints)
            .where(eq(experienceBlueprints.id, scope.shareBlueprintId))
        )[0];
  if (!bp) throw new NotFoundError("Blueprint not found");
  const detail = await blueprintDetail(db, bp);
  if (!detail.current)
    throw new StateConflictError("The blueprint has no revision yet.");
  const content = detail.current.content as BlueprintContentT;
  const report = detail.current.traceabilityReport as TraceabilityReport;
  const meta = {
    revisionNumber: detail.current.revisionNumber,
    createdAt: detail.current.createdAt.toISOString().slice(0, 10),
    author: detail.current.author,
    hypotheses: detail.hypotheses.map((h) => h!.title),
  };
  const slug =
    content.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "blueprint";
  if (format === "md")
    return {
      filename: `${slug}-r${meta.revisionNumber}.md`,
      contentType: "text/markdown; charset=utf-8",
      body: blueprintMarkdown({
        content,
        appendix: detail.appendix,
        report,
        ...meta,
      }),
    };
  return {
    filename: `${slug}-r${meta.revisionNumber}.json`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(
      {
        format: "tessaloom.blueprint.v1",
        blueprint: { id: bp.id, status: bp.status, ...meta },
        traceabilityReport: report,
        content,
        evidenceAppendix: detail.appendix,
      },
      null,
      2,
    ),
  };
}

// ---------------------------------------------------------------------------
// Share links (SECURITY §4.3)

export async function createProjectShareLink(
  db: Executor,
  input: {
    workspaceId: string;
    projectId: string;
    scope: "project" | "experiment" | "blueprint";
    targetId: string;
    tokenHash: string;
    expiresInDays: number;
  },
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, input.projectId),
        eq(projects.workspaceId, input.workspaceId),
      ),
    );
  if (!project) throw new NotFoundError("Project not found");
  // The target must belong to this project.
  const target =
    input.scope === "project"
      ? input.targetId === project.id
      : input.scope === "experiment"
        ? (
            await db
              .select({ id: experiments.id })
              .from(experiments)
              .where(
                and(
                  eq(experiments.id, input.targetId),
                  eq(experiments.projectId, project.id),
                ),
              )
          ).length > 0
        : (
            await db
              .select({ id: experienceBlueprints.id })
              .from(experienceBlueprints)
              .where(
                and(
                  eq(experienceBlueprints.id, input.targetId),
                  eq(experienceBlueprints.projectId, project.id),
                ),
              )
          ).length > 0;
  if (!target) throw new NotFoundError("Share target not found");
  return createShareLink(db, {
    projectId: project.id,
    scope: input.scope,
    targetId: input.targetId,
    tokenHash: input.tokenHash,
    expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
  });
}

export async function listShareLinks(
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
  return db
    .select({
      id: shareLinks.id,
      scope: shareLinks.scope,
      targetId: shareLinks.targetId,
      createdAt: shareLinks.createdAt,
      expiresAt: shareLinks.expiresAt,
      revokedAt: shareLinks.revokedAt,
      viewCount: shareLinks.viewCount,
    })
    .from(shareLinks)
    .where(eq(shareLinks.projectId, projectId))
    .orderBy(desc(shareLinks.createdAt));
}

export async function revokeWorkspaceShareLink(
  db: Executor,
  workspaceId: string,
  shareLinkId: string,
) {
  const [row] = await db
    .select({ projectId: shareLinks.projectId })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(
      and(
        eq(shareLinks.id, shareLinkId),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new NotFoundError("Share link not found");
  await revokeShareLink(db, { shareLinkId, projectId: row.projectId });
}

/**
 * GET /share/:token — a read-only payload for the link's scope only. No workspace ids, run
 * controls, configuration, or raw request arguments are included.
 */
export async function sharedView(db: Executor, tokenHash: string) {
  const link = await findActiveShareLink(db, tokenHash);
  if (!link) return null;
  return sharedViewOfLink(db, link);
}

/** Featured, active share links listed publicly as read-only demo samples (M10-A). */
export async function listSamples(db: Executor, now = new Date()) {
  return db
    .select({
      id: shareLinks.id,
      scope: shareLinks.scope,
      projectName: projects.name,
      useCase: projects.useCase,
      createdAt: shareLinks.createdAt,
      fixture: sql<boolean>`exists (select 1 from experiments e where e.project_id = ${projects.id} and e.mode = 'fixture')`,
    })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(
      and(
        eq(shareLinks.featured, true),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, now),
      ),
    )
    .orderBy(desc(shareLinks.createdAt));
}

/** A sample's read-only payload: stored data only, never a run or an LLM call. */
export async function sampleView(
  db: Executor,
  linkId: string,
  now = new Date(),
) {
  const [link] = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.id, linkId),
        eq(shareLinks.featured, true),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, now),
      ),
    );
  return link ? sharedViewOfLink(db, link) : null;
}

/** Operator action (admin CLI): list or unlist a share link as a public sample. */
export async function setSampleFeatured(
  db: Executor,
  linkId: string,
  featured: boolean,
) {
  const rows = await db
    .update(shareLinks)
    .set({ featured })
    .where(eq(shareLinks.id, linkId))
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

async function sharedViewOfLink(
  db: Executor,
  link: typeof shareLinks.$inferSelect,
) {
  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.id, link.id));
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, link.projectId));
  const base = {
    scope: link.scope,
    expiresAt: link.expiresAt,
    project: { name: project!.name, useCase: project!.useCase },
  };
  if (link.scope === "blueprint") {
    const [bp] = await db
      .select()
      .from(experienceBlueprints)
      .where(eq(experienceBlueprints.id, link.targetId));
    if (!bp) return null;
    const d = await blueprintDetail(db, bp);
    return {
      ...base,
      blueprint: {
        format: d.blueprint.format,
        status: d.blueprint.status,
        hypotheses: d.hypotheses.map((h) => ({
          title: h!.title,
          status: h!.status,
        })),
        revision: d.current
          ? {
              revisionNumber: d.current.revisionNumber,
              author: d.current.author,
              createdAt: d.current.createdAt,
              content: d.current.content,
              traceabilityReport: d.current.traceabilityReport,
            }
          : null,
        // Shared payloads carry no invocation ids (the trace needs a workspace).
        appendix: d.appendix.map((a) => {
          const shared: Partial<typeof a> = { ...a };
          delete shared.toolInvocationId;
          return shared;
        }),
      },
    };
  }
  if (link.scope === "experiment") {
    const [e] = await db
      .select()
      .from(experiments)
      .where(eq(experiments.id, link.targetId));
    if (!e) return null;
    const view = await experimentView(db, project!.workspaceId, e.id);
    return {
      ...base,
      experiment: {
        kind: view.experiment.kind,
        brief: view.brief
          ? { title: (view.brief.content as { title: string }).title }
          : null,
        entities: view.entities.map((x) => ({
          id: x.id,
          name: x.name,
          domain: x.domain,
          provenanceClass: x.provenanceClass,
        })),
        hypotheses: view.hypotheses.map((h) => ({
          id: h.id,
          title: h.title,
          premise: h.premise,
          status: h.status,
          retired: h.retired,
          compositeScore: h.compositeScore,
          elements: h.elements.map((el) => el.entityId),
          claims: h.claims.map((c) => ({
            id: c.id,
            statement: c.statement,
            testKind: c.testKind,
            stance: c.currentStance,
          })),
          evidence: h.evidence.map((ev) => ({
            id: ev.id,
            claimId: ev.claimId,
            stance: ev.stance,
            rationale: ev.rationale,
            provenanceClass: ev.provenanceClass,
            dataOrigin: ev.dataOrigin,
            retrievedAt: ev.retrievedAt,
          })),
        })),
      },
    };
  }
  const [exps, bps] = await Promise.all([
    db
      .select({
        id: experiments.id,
        kind: experiments.kind,
        label: experiments.label,
        mode: experiments.mode,
        createdAt: experiments.createdAt,
      })
      .from(experiments)
      .where(eq(experiments.projectId, project!.id))
      .orderBy(asc(experiments.createdAt)),
    listBlueprints(db, project!.workspaceId, project!.id),
  ]);
  return {
    ...base,
    overview: {
      // Overview payloads omit individual evidence; retain the fixture marker so
      // the reader banner and production firewall cannot lose it in projection.
      ...(exps.some((x) => x.mode === "fixture")
        ? { provenanceClass: "DEVELOPMENT_FIXTURE" as const }
        : {}),
      experiments: exps.map((x) => ({
        kind: x.kind,
        label: x.label,
        createdAt: x.createdAt,
      })),
      blueprints: bps.map((b) => ({
        title: b.title,
        format: b.format,
        status: b.status,
        revisionNumber: b.revisionNumber,
      })),
    },
  };
}
