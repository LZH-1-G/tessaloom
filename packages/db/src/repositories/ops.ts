import { and, desc, eq, gt, isNull, max, sql } from "drizzle-orm";
import {
  BlueprintContent,
  type BlueprintContent as BlueprintContentT,
  canonicalHash,
  uuidv7,
} from "@tessaloom/core";
import type { Executor, Tx } from "../client";
import { NotFoundError, StateConflictError } from "../errors";
import {
  blueprintRevisions,
  experienceBlueprints,
  experimentComparisons,
  graphLayouts,
  idempotencyKeys,
  llmInvocations,
  promptTemplates,
  shareLinks,
  usageCounters,
  workerHeartbeats,
} from "../schema";

// --- Usage counters (quota and cost guards; one atomic upsert per increment) ---

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function incrementUsage(
  db: Executor,
  input: {
    scope: "global" | "workspace";
    scopeId: string;
    metric: string;
    amount?: number;
    day?: string;
  },
): Promise<number> {
  const amount = input.amount ?? 1;
  const [row] = await db
    .insert(usageCounters)
    .values({
      scope: input.scope,
      scopeId: input.scopeId,
      metric: input.metric,
      day: input.day ?? utcDay(),
      value: amount,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.scope,
        usageCounters.scopeId,
        usageCounters.metric,
        usageCounters.day,
      ],
      set: { value: sql`${usageCounters.value} + ${amount}` },
    })
    .returning({ value: usageCounters.value });
  return row!.value;
}

/** Atomically consume `amount` only if the result stays within `limit`; returns the new value or null. */
export async function consumeWithinLimit(
  db: Executor,
  input: {
    scope: "global" | "workspace";
    scopeId: string;
    metric: string;
    limit: number;
    amount?: number;
    day?: string;
  },
): Promise<number | null> {
  const amount = input.amount ?? 1;
  if (amount > input.limit) return null;
  const result = await db.execute<{ value: string }>(sql`
    INSERT INTO usage_counters (scope, scope_id, metric, day, value)
    VALUES (${input.scope}, ${input.scopeId}, ${input.metric}, ${input.day ?? utcDay()}, ${amount})
    ON CONFLICT (scope, scope_id, metric, day)
    DO UPDATE SET value = usage_counters.value + ${amount}
    WHERE usage_counters.value + ${amount} <= ${input.limit}
    RETURNING value`);
  const value = result.rows[0]?.value;
  return value === undefined ? null : Number(value);
}

export async function getUsage(
  db: Executor,
  input: {
    scope: "global" | "workspace";
    scopeId: string;
    metric: string;
    day?: string;
  },
) {
  const [row] = await db
    .select({ value: usageCounters.value })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.scope, input.scope),
        eq(usageCounters.scopeId, input.scopeId),
        eq(usageCounters.metric, input.metric),
        eq(usageCounters.day, input.day ?? utcDay()),
      ),
    );
  return row?.value ?? 0;
}

// --- Worker heartbeat ---

export async function beatWorker(
  db: Executor,
  input: {
    workerId: string;
    qlooReady: boolean;
    harnessVersion?: string | null;
    transport?: string | null;
    runConfig?: unknown;
  },
) {
  await db
    .insert(workerHeartbeats)
    .values({ ...input, lastBeatAt: sql`now()` })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        lastBeatAt: sql`now()`,
        qlooReady: input.qlooReady,
        harnessVersion: input.harnessVersion ?? null,
        transport: input.transport ?? null,
        runConfig: input.runConfig ?? null,
      },
    });
}

export async function latestHeartbeat(db: Executor) {
  const [row] = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.lastBeatAt))
    .limit(1);
  return row ?? null;
}

// --- Idempotency keys (24 h) ---

export async function findIdempotentResponse(
  db: Executor,
  workspaceId: string,
  key: string,
) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.workspaceId, workspaceId),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return row ?? null;
}

export async function storeIdempotentResponse(
  db: Executor,
  input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    response: unknown;
  },
) {
  await db.insert(idempotencyKeys).values(input).onConflictDoNothing();
}

// --- Prompt registry mirror ---

export async function registerPromptTemplate(
  db: Executor,
  input: { promptId: string; version: string; contentHash: string },
) {
  await db.insert(promptTemplates).values(input).onConflictDoNothing();
}

// --- LLM invocation records ---

export async function recordLlmInvocation(
  db: Executor,
  input: Omit<typeof llmInvocations.$inferInsert, "id"> & { id?: string },
) {
  const [row] = await db
    .insert(llmInvocations)
    .values({ ...input, id: input.id ?? uuidv7() })
    .returning();
  return row!;
}

// --- Comparisons and graph layouts ---

export async function insertComparison(
  db: Executor,
  input: Omit<typeof experimentComparisons.$inferInsert, "id">,
) {
  const [row] = await db
    .insert(experimentComparisons)
    .values({ ...input, id: uuidv7() })
    .onConflictDoNothing({
      target: [
        experimentComparisons.baseExperimentId,
        experimentComparisons.otherExperimentId,
        experimentComparisons.metricsVersion,
      ],
    })
    .returning();
  return row ?? null;
}

export async function getGraphLayout(db: Executor, experimentId: string) {
  const [row] = await db
    .select()
    .from(graphLayouts)
    .where(eq(graphLayouts.experimentId, experimentId));
  return (row?.positions ?? null) as Record<
    string,
    { x: number; y: number }
  > | null;
}

export async function saveGraphLayout(
  db: Executor,
  experimentId: string,
  positions: Record<string, { x: number; y: number }>,
) {
  await db
    .insert(graphLayouts)
    .values({ experimentId, positions })
    .onConflictDoUpdate({
      target: graphLayouts.experimentId,
      set: { positions, updatedAt: sql`now()` },
    });
}

// --- Blueprints and append-only revisions (optimistic concurrency on the base revision) ---

export async function createBlueprint(
  db: Executor,
  input: {
    projectId: string;
    experimentId: string;
    hypothesisIds: string[];
    format: "event" | "series" | "installation";
  },
) {
  const [row] = await db
    .insert(experienceBlueprints)
    .values({ ...input, id: uuidv7() })
    .returning();
  return row!;
}

export async function addBlueprintRevision(
  tx: Tx,
  input: {
    blueprintId: string;
    baseRevisionId: string | null;
    author: "AGENT" | "USER";
    runId?: string | null;
    content: BlueprintContentT;
    traceabilityReport: Record<string, unknown>;
    changeSummary?: string | null;
  },
) {
  const content = BlueprintContent.parse(input.content);
  const [blueprint] = await tx
    .select()
    .from(experienceBlueprints)
    .where(eq(experienceBlueprints.id, input.blueprintId))
    .for("update");
  if (!blueprint) throw new NotFoundError("Blueprint not found");
  if ((blueprint.currentRevisionId ?? null) !== input.baseRevisionId) {
    throw new StateConflictError("Blueprint was revised concurrently");
  }
  const [current] = await tx
    .select({ value: max(blueprintRevisions.revisionNumber) })
    .from(blueprintRevisions)
    .where(eq(blueprintRevisions.blueprintId, input.blueprintId));
  const [revision] = await tx
    .insert(blueprintRevisions)
    .values({
      id: uuidv7(),
      blueprintId: input.blueprintId,
      revisionNumber: (current?.value ?? 0) + 1,
      parentRevisionId: input.baseRevisionId,
      author: input.author,
      runId: input.runId ?? null,
      content,
      contentHash: canonicalHash(content),
      traceabilityReport: input.traceabilityReport,
      changeSummary: input.changeSummary ?? null,
    })
    .returning();
  await tx
    .update(experienceBlueprints)
    .set({ currentRevisionId: revision!.id, updatedAt: sql`now()` })
    .where(eq(experienceBlueprints.id, input.blueprintId));
  return revision!;
}

// --- Share links (only a peppered token hash is stored) ---

export async function createShareLink(
  db: Executor,
  input: {
    projectId: string;
    scope: "project" | "experiment" | "blueprint";
    targetId: string;
    tokenHash: string;
    expiresAt: Date;
  },
) {
  const [row] = await db
    .insert(shareLinks)
    .values({ ...input, id: uuidv7() })
    .returning();
  return row!;
}

export async function findActiveShareLink(
  db: Executor,
  tokenHash: string,
  now = new Date(),
) {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.tokenHash, tokenHash),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, now),
      ),
    );
  return row ?? null;
}

export async function revokeShareLink(
  db: Executor,
  input: { shareLinkId: string; projectId: string },
) {
  const [row] = await db
    .update(shareLinks)
    .set({ revokedAt: sql`coalesce(${shareLinks.revokedAt}, now())` })
    .where(
      and(
        eq(shareLinks.id, input.shareLinkId),
        eq(shareLinks.projectId, input.projectId),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Share link not found");
  return row;
}
