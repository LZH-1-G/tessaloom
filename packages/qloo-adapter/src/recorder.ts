import {
  consumeWithinLimit,
  recordSnapshot,
  recordToolInvocation,
  withTx,
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
          correlationId: input.parsed?.correlationId ?? null,
          harnessEndpoint: input.parsed?.endpoint ?? null,
          harnessRequests: input.parsed?.requests ?? [],
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
