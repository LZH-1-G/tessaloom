import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import {
  ExperimentDefinition,
  type ExperimentDefinition as ExperimentDefinitionT,
  RunBudget,
  RunConfig,
  RunUsage,
  type RunKind,
  type RunState,
  experimentKey,
  uuidv7,
} from "@tessaloom/core";
import type { Executor, Tx } from "../client";
import { NotFoundError, StateConflictError } from "../errors";
import {
  agentRuns,
  counterfactualBranches,
  experimentSeeds,
  experiments,
  runEvents,
} from "../schema";

type ExperimentRow = typeof experiments.$inferSelect;

/**
 * Create an experiment, or return the existing one with the same deterministic key
 * (DATABASE_SCHEMA §6 "Start experiment"; AGENT_WORKFLOW §14.1).
 */
export async function createOrGetExperiment(
  tx: Tx,
  input: {
    projectId: string;
    briefVersionId: string;
    definition: ExperimentDefinitionT;
    mode: "live" | "replay" | "fixture";
    parentExperimentId?: string | null;
    label?: string | null;
    seeds?: {
      entityId: string;
      role: "seed" | "tag_constraint" | "location";
    }[];
  },
): Promise<{ experiment: ExperimentRow; reused: boolean }> {
  const definition = ExperimentDefinition.parse(input.definition);
  const key = experimentKey(definition);
  const id = uuidv7();
  let rootExperimentId = id;
  if (input.parentExperimentId) {
    const [parent] = await tx
      .select()
      .from(experiments)
      .where(eq(experiments.id, input.parentExperimentId));
    if (!parent) throw new NotFoundError("Parent experiment not found");
    rootExperimentId = parent.rootExperimentId ?? parent.id;
  }
  const inserted = await tx
    .insert(experiments)
    .values({
      id,
      projectId: input.projectId,
      briefVersionId: input.briefVersionId,
      kind: input.parentExperimentId ? "BRANCH" : "ROOT",
      parentExperimentId: input.parentExperimentId ?? null,
      rootExperimentId,
      experimentKey: key,
      definition,
      label: input.label ?? null,
      mode: input.mode,
    })
    .onConflictDoNothing({
      target: [experiments.projectId, experiments.experimentKey],
    })
    .returning();
  if (inserted[0]) {
    if (input.seeds?.length) {
      await tx.insert(experimentSeeds).values(
        input.seeds.map((seed, ordinal) => ({
          experimentId: id,
          entityId: seed.entityId,
          role: seed.role,
          ordinal,
        })),
      );
    }
    return { experiment: inserted[0], reused: false };
  }
  const [existing] = await tx
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.projectId, input.projectId),
        eq(experiments.experimentKey, key),
      ),
    );
  return { experiment: existing!, reused: true };
}

export async function createBranch(
  tx: Tx,
  input: Parameters<typeof createOrGetExperiment>[1] & {
    parentExperimentId: string;
    variableDelta: unknown;
    mode: "live" | "replay" | "fixture";
    branchMode: "hold_hypotheses" | "regenerate";
    plannedDirtyQueries: number;
    plannedReusedQueries: number;
  },
) {
  const result = await createOrGetExperiment(tx, input);
  if (!result.reused) {
    await tx.insert(counterfactualBranches).values({
      id: uuidv7(),
      parentExperimentId: input.parentExperimentId,
      branchExperimentId: result.experiment.id,
      variableDelta: input.variableDelta,
      mode: input.branchMode,
      plannedDirtyQueries: input.plannedDirtyQueries,
      plannedReusedQueries: input.plannedReusedQueries,
    });
  }
  return result;
}

export async function getExperiment(db: Executor, experimentId: string) {
  const [row] = await db
    .select()
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  if (!row) throw new NotFoundError("Experiment not found");
  return row;
}

export async function listExperimentTree(
  db: Executor,
  rootExperimentId: string,
) {
  return db
    .select()
    .from(experiments)
    .where(eq(experiments.rootExperimentId, rootExperimentId))
    .orderBy(asc(experiments.createdAt));
}

export async function setExperimentStatus(
  db: Executor,
  experimentId: string,
  status: ExperimentRow["status"],
) {
  const terminal = [
    "COMPLETED",
    "COMPLETED_WITH_LIMITS",
    "FAILED",
    "CANCELLED",
  ].includes(status);
  await db
    .update(experiments)
    .set({ status, completedAt: terminal ? sql`now()` : null })
    .where(eq(experiments.id, experimentId));
}

// --- Agent runs (AGENT_WORKFLOW §6) ---

export async function createRun(
  db: Executor,
  input: {
    experimentId: string;
    kind: RunKind;
    budget: unknown;
    config: unknown;
    blueprintId?: string | null;
  },
) {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: uuidv7(),
      experimentId: input.experimentId,
      kind: input.kind,
      budget: RunBudget.parse(input.budget),
      usage: RunUsage.parse({}),
      configSnapshot: RunConfig.parse(input.config),
      blueprintId: input.blueprintId ?? null,
      traceId: uuidv7().replace(/-/g, ""),
    })
    .returning();
  return row!;
}

export async function getRun(db: Executor, runId: string) {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!row) throw new NotFoundError("Run not found");
  return row;
}

/** Lock a run row for a step commit; returns null when the expected version is stale. */
export async function lockRunAtVersion(
  tx: Tx,
  runId: string,
  expectedStateVersion: number,
) {
  const [row] = await tx
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  if (!row) throw new NotFoundError("Run not found");
  return row.stateVersion === expectedStateVersion ? row : null;
}

/**
 * Optimistic state transition: succeeds only if `state_version` still equals the expected
 * value, then increments it. Transition legality (the state machine) is enforced in M4.
 */
export async function transitionRun(
  db: Executor,
  input: {
    runId: string;
    expectedStateVersion: number;
    to: RunState;
    usage?: unknown;
    pendingConfirmation?: unknown | null;
    terminalReason?: string | null;
    error?: unknown | null;
    iteration?: number;
  },
) {
  const terminal = [
    "COMPLETED",
    "COMPLETED_WITH_LIMITS",
    "FAILED",
    "CANCELLED",
  ].includes(input.to);
  const [row] = await db
    .update(agentRuns)
    .set({
      state: input.to,
      stateVersion: sql`${agentRuns.stateVersion} + 1`,
      ...(input.usage !== undefined
        ? { usage: RunUsage.parse(input.usage) }
        : {}),
      ...(input.pendingConfirmation !== undefined
        ? { pendingConfirmation: input.pendingConfirmation }
        : {}),
      ...(input.terminalReason !== undefined
        ? { terminalReason: input.terminalReason }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      ...(terminal ? { finishedAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.stateVersion, input.expectedStateVersion),
      ),
    )
    .returning();
  if (!row) throw new StateConflictError("Run state changed concurrently");
  return row;
}

export async function requestRunCancel(db: Executor, runId: string) {
  await db
    .update(agentRuns)
    .set({
      cancelRequestedAt: sql`coalesce(${agentRuns.cancelRequestedAt}, now())`,
    })
    .where(eq(agentRuns.id, runId));
}

// --- Run events (append-only; gap-free seq per run) ---

export interface NewRunEvent {
  type: string;
  state: RunState;
  role?: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | null;
  summary: string;
  payload?: Record<string, unknown>;
}

/** Append events with contiguous sequence numbers. Locks the run row to serialize writers. */
export async function appendRunEvents(
  tx: Tx,
  runId: string,
  events: NewRunEvent[],
) {
  if (events.length === 0) return [];
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  const [current] = await tx
    .select({ value: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  const start = (current?.value ?? 0) + 1;
  return tx
    .insert(runEvents)
    .values(
      events.map((event, index) => ({
        runId,
        seq: start + index,
        type: event.type,
        state: event.state,
        role: event.role ?? null,
        summary: event.summary,
        payload: event.payload ?? {},
      })),
    )
    .returning();
}

export async function listRunEventsAfter(
  db: Executor,
  runId: string,
  afterSeq = 0,
  limit = 200,
) {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
}

export async function listRunsForExperiment(
  db: Executor,
  experimentId: string,
) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.experimentId, experimentId))
    .orderBy(desc(agentRuns.createdAt));
}
