import { and, desc, eq, gt, sql } from "drizzle-orm";
import { type EnvelopeSummary, uuidv7 } from "@tessaloom/core";
import type { Executor } from "../client";
import { DomainRuleError } from "../errors";
import { qlooResponseSnapshots, toolInvocations } from "../schema";

/** Keep the response retrieval date separate from a later invocation/reuse date.
 * Follow legacy cache rows too; broken/cyclic chains return null, never fresh-looking reuse time.
 * Correlated to toolInvocations in the enclosing, workspace-scoped read query.
 */
export const sourceRetrievedAt = sql<Date | null>`(
  WITH RECURSIVE lineage AS (
    SELECT source.id, source.snapshot_id, source.created_at, source.data_origin,
           source.cache_source_invocation_id, 0 AS depth
    FROM tool_invocations source WHERE source.id = ${sql.raw('"tool_invocations"."id"')}
    UNION ALL
    SELECT source.id, source.snapshot_id, source.created_at, source.data_origin,
           source.cache_source_invocation_id, parent.depth + 1
    FROM tool_invocations source JOIN lineage parent ON source.id = parent.cache_source_invocation_id
    WHERE parent.data_origin = 'CACHE' AND parent.depth < 32
      AND source.project_id = ${sql.raw('"tool_invocations"."project_id"')}
  )
  SELECT coalesce(snapshot.retrieved_at,
    CASE WHEN source.data_origin = 'REPLAY' THEN NULL ELSE source.created_at END)
  FROM lineage source LEFT JOIN qloo_response_snapshots snapshot ON snapshot.id = source.snapshot_id
  WHERE source.data_origin <> 'CACHE' ORDER BY source.depth DESC LIMIT 1
)`.mapWith((value: string | Date) => new Date(value));

/**
 * Raw Qloo payload retention. "off" (default) stores only the structural summary; raw
 * responses are not persisted until storage/redistribution permission is confirmed (R-08).
 */
export type RawRetention = "off" | "on";

export async function recordSnapshot(
  db: Executor,
  input: {
    requestHash: string;
    workflow: string;
    transport: "HARNESS_MCP" | "HARNESS_CLI" | "FIXTURE";
    harnessVersion: string;
    summary: EnvelopeSummary;
    retrievedAt: Date;
    expiresAt: Date;
    isFixture: boolean;
    raw?: unknown;
    rawRetention?: RawRetention;
  },
) {
  const retain =
    (input.rawRetention ?? "off") === "on" && input.raw !== undefined;
  const rawJson = retain ? JSON.stringify(input.raw) : null;
  if (rawJson && rawJson.length > 2_000_000) {
    throw new DomainRuleError(
      "Raw Qloo payload exceeds the 2 MB retention limit",
    );
  }
  const [row] = await db
    .insert(qlooResponseSnapshots)
    .values({
      id: uuidv7(),
      requestHash: input.requestHash,
      workflow: input.workflow,
      transport: input.transport,
      harnessVersion: input.harnessVersion,
      envelopeStatus: input.summary.status,
      envelopeShape: input.summary.shape,
      resultCount: input.summary.resultCount,
      rawRetained: retain,
      raw: retain ? input.raw : null,
      rawBytes: rawJson ? Buffer.byteLength(rawJson) : null,
      isFixture: input.isFixture,
      retrievedAt: input.retrievedAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row!;
}

export async function findFreshSnapshot(
  db: Executor,
  requestHash: string,
  now = new Date(),
) {
  const [row] = await db
    .select()
    .from(qlooResponseSnapshots)
    .where(
      and(
        eq(qlooResponseSnapshots.requestHash, requestHash),
        gt(qlooResponseSnapshots.expiresAt, now),
      ),
    )
    .orderBy(desc(qlooResponseSnapshots.retrievedAt))
    .limit(1);
  return row ?? null;
}

export async function pinSnapshot(db: Executor, snapshotId: string) {
  await db
    .update(qlooResponseSnapshots)
    .set({ pinned: true })
    .where(eq(qlooResponseSnapshots.id, snapshotId));
}

export async function recordToolInvocation(
  db: Executor,
  input: {
    projectId: string;
    runId?: string | null;
    stepSeq?: number | null;
    purpose: string;
    method: string;
    workflow: string;
    transport: "HARNESS_MCP" | "HARNESS_CLI" | "FIXTURE";
    argsRedacted: Record<string, unknown>;
    requestHash: string;
    snapshotId?: string | null;
    dataOrigin: "LIVE" | "CACHE" | "REPLAY" | "FIXTURE";
    cacheSourceInvocationId?: string | null;
    summary: EnvelopeSummary;
    correlationId?: string | null;
    harnessEndpoint?: string | null;
    harnessRequests?: unknown[];
    attempt?: number;
    latencyMs?: number | null;
  },
) {
  const [row] = await db
    .insert(toolInvocations)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      runId: input.runId ?? null,
      stepSeq: input.stepSeq ?? null,
      purpose: input.purpose,
      method: input.method,
      workflow: input.workflow,
      transport: input.transport,
      argsRedacted: input.argsRedacted,
      requestHash: input.requestHash,
      snapshotId: input.snapshotId ?? null,
      dataOrigin: input.dataOrigin,
      cacheSourceInvocationId: input.cacheSourceInvocationId ?? null,
      envelopeStatus: input.summary.status,
      envelopeShape: input.summary.shape,
      resultCount: input.summary.resultCount,
      errorCode: input.summary.errorCode,
      correlationId: input.correlationId ?? null,
      harnessEndpoint: input.harnessEndpoint ?? null,
      harnessRequests: input.harnessRequests ?? [],
      attempt: input.attempt ?? 1,
      latencyMs: input.latencyMs ?? null,
    })
    .returning();
  return row!;
}

export async function getToolInvocation(db: Executor, id: string) {
  const [row] = await db
    .select()
    .from(toolInvocations)
    .where(eq(toolInvocations.id, id));
  return row ?? null;
}

/** Retention: delete expired, unpinned snapshots that no invocation references. */
export async function purgeExpiredSnapshots(db: Executor, graceDays = 7) {
  const result = await db.execute(sql`
    DELETE FROM qloo_response_snapshots s
    WHERE NOT s.pinned
      AND s.expires_at < now() - make_interval(days => ${graceDays})
      AND NOT EXISTS (SELECT 1 FROM tool_invocations t WHERE t.snapshot_id = s.id)`);
  return result.rowCount ?? 0;
}
