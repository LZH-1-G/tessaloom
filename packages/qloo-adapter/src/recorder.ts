import {
  consumeWithinLimit,
  recordSnapshot,
  recordToolInvocation,
  withTx,
  getToolInvocation,
  type Db,
  type RawRetention,
} from "@tessaloom/db";
import type { InvocationRecorder, QuotaGuard } from "./adapter";

/**
 * Records every Qloo call in `tool_invocations` with the harness's own provenance. A structural
 * snapshot is written only when the harness returned an envelope; the raw payload is stored
 * only when retention is explicitly "on" (default "off" until permission is confirmed; R-08).
 */
export function createDbRecorder(
  db: Db,
  options: { rawRetention?: RawRetention } = {},
): InvocationRecorder {
  return {
    async record(input) {
      return withTx(db, async (tx) => {
        let snapshotId: string | null = null;
        // Reuse structural provenance, never a raw response or a new retrieval timestamp.
        const source =
          input.dataOrigin === "CACHE" && input.cacheSourceInvocationId
            ? await getToolInvocation(tx, input.cacheSourceInvocationId)
            : null;
        if (source && source.projectId !== input.ctx.projectId)
          throw new Error("Cache source project mismatch");
        if (source) snapshotId = source.snapshotId;
        if (input.parsed && input.dataOrigin !== "CACHE") {
          const snapshot = await recordSnapshot(tx, {
            requestHash: input.requestHash,
            workflow: input.workflow,
            transport: input.transport,
            harnessVersion: input.harnessVersion,
            summary: input.envelope,
            retrievedAt: input.retrievedAt,
            expiresAt: new Date(input.retrievedAt.getTime() + input.ttlMs),
            isFixture: input.dataOrigin === "FIXTURE",
            raw: input.raw,
            rawRetention: options.rawRetention ?? "off",
          });
          snapshotId = snapshot.id;
        }
        const invocation = await recordToolInvocation(tx, {
          projectId: input.ctx.projectId,
          runId: input.ctx.runId ?? null,
          stepSeq: input.ctx.stepSeq ?? null,
          purpose: input.ctx.purpose,
          method: input.method,
          workflow: input.workflow,
          transport: input.transport,
          argsRedacted: input.args,
          requestHash: input.requestHash,
          snapshotId,
          dataOrigin: input.dataOrigin,
          cacheSourceInvocationId: input.cacheSourceInvocationId ?? null,
          summary: input.envelope,
          correlationId:
            input.parsed?.correlationId ?? source?.correlationId ?? null,
          harnessEndpoint:
            input.parsed?.endpoint ?? source?.harnessEndpoint ?? null,
          harnessRequests:
            input.parsed?.requests ??
            (Array.isArray(source?.harnessRequests)
              ? source.harnessRequests
              : []),
          attempt: input.attempt,
          latencyMs: input.latencyMs,
        });
        return { toolInvocationId: invocation.id, snapshotId };
      });
    },
  };
}

/** Conservative daily guard (ARCHITECTURE §12): one atomic reservation per live call. */
export function createDbQuotaGuard(
  db: Db,
  options: { dailyLimit: number; scopeId?: string },
): QuotaGuard {
  return {
    async consume() {
      const value = await consumeWithinLimit(db, {
        scope: "global",
        scopeId: options.scopeId ?? "qloo",
        metric: "qloo_calls",
        limit: options.dailyLimit,
      });
      return value !== null;
    },
  };
}
