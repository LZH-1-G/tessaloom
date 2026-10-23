import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../packages/core/src";
import {
  createProject,
  createWorkspace,
  invocationTrace,
  recordToolInvocation,
  sql,
  type Db,
} from "../../packages/db/src";
import {
  QlooAdapter,
  createDbQuotaGuard,
  createDbRecorder,
  type HarnessTransport,
  type RawHarnessResult,
} from "../../packages/qloo-adapter/src";
import { createTestDatabase } from "./helpers/test-db";

let db: Db;
let drop: () => Promise<void>;
let projectId: string;
let workspaceId: string;

// Synthetic payload mirroring the V1-observed recommend shape; values are fictional.
const recommendOk = {
  schema_version: "1.0-preview.1",
  operation: "recommend",
  status: "ok",
  result_count: 1,
  results: [
    {
      entity_id: "M1",
      name: "Film One",
      type: "urn:entity",
      subtype: "urn:entity:movie",
      popularity: 0.8,
      affinity: 0.89,
    },
  ],
  provenance: {
    source: "Qloo API",
    endpoint: "/v2/insights",
    requests: [
      {
        method: "GET",
        path: "/v2/insights",
        query: { "filter.type": "urn:entity:movie", take: 10 },
      },
    ],
  },
  execution: {
    transport: "direct",
    transport_name: "Qloo API",
    correlation_id: "corr-int",
    duration_ms: 12,
  },
};

class StubLiveTransport implements HarnessTransport {
  readonly name = "HARNESS_CLI" as const;
  calls = 0;
  async call(): Promise<RawHarnessResult> {
    this.calls++;
    return {
      payload: recommendOk,
      exitCode: 0,
      durationMs: 12,
      transport: this.name,
    };
  }
}

beforeAll(async () => {
  const test = await createTestDatabase();
  db = test.handle.db;
  drop = test.drop;
  const workspace = await createWorkspace(db, { secretHash: "a".repeat(64) });
  workspaceId = workspace.id;
  projectId = (
    await createProject(db, {
      workspaceId: workspace.id,
      name: "Adapter",
      useCase: "cafe",
    })
  ).id;
});
afterAll(async () => {
  await drop?.();
});

describe("adapter + database recorder", () => {
  it("records harness provenance, never stores raw payloads by default, and links cache hits", async () => {
    const transport = new StubLiveTransport();
    const retrievedAt = new Date("2026-10-01T10:00:00Z");
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      now: () => retrievedAt.getTime(),
      recorder: createDbRecorder(db),
      sleep: async () => {},
    });
    const ctx = { projectId, purpose: "claim:test" };
    const first = await adapter.recommend(
      { targetType: "movie", signals: ["S"] },
      ctx,
    );
    const second = await adapter.recommend(
      { targetType: "movie", signals: ["S"] },
      ctx,
    );
    expect(transport.calls).toBe(1);
    if (first.kind !== "OK" || second.kind !== "OK")
      throw new Error("expected OK outcomes");

    const rows = await db.execute<{
      id: string;
      data_origin: string;
      correlation_id: string | null;
      harness_endpoint: string | null;
      harness_requests: unknown;
      cache_source_invocation_id: string | null;
      snapshot_id: string | null;
      envelope_shape: string;
    }>(
      sql`SELECT id, data_origin, correlation_id, harness_endpoint, harness_requests, cache_source_invocation_id, snapshot_id, envelope_shape FROM tool_invocations WHERE project_id = ${projectId} ORDER BY created_at`,
    );
    expect(rows.rows).toHaveLength(2);
    const [live, cached] = rows.rows;
    expect(live).toMatchObject({
      id: first.provenance.toolInvocationId,
      data_origin: "LIVE",
      correlation_id: "corr-int",
      harness_endpoint: "/v2/insights",
      envelope_shape: "result_list",
      cache_source_invocation_id: null,
    });
    expect(live!.harness_requests).toEqual(recommendOk.provenance.requests);
    expect(cached).toMatchObject({
      data_origin: "CACHE",
      cache_source_invocation_id: live!.id,
      snapshot_id: live!.snapshot_id,
      harness_endpoint: "/v2/insights",
      correlation_id: "corr-int",
      harness_requests: recommendOk.provenance.requests,
    });

    expect(second.provenance.snapshotId).toBe(first.provenance.snapshotId);
    expect(second.provenance.retrievedAt).toBe(retrievedAt.toISOString());
    for (const invocation of [live!, cached!]) {
      const trace = await invocationTrace(db, workspaceId, invocation.id);
      expect(trace.retrievedAt).toEqual(retrievedAt);
      expect(trace.invokedAt.getTime()).toBeGreaterThan(retrievedAt.getTime());
    }

    // Existing rows can have no snapshot link. Even nested legacy reuse must resolve
    // the original source date, while retaining a distinct invocation timestamp.
    let sourceId = live!.id;
    for (let i = 0; i < 2; i++) {
      const legacy = await recordToolInvocation(db, {
        projectId,
        purpose: "legacy cache regression",
        method: "recommend",
        workflow: "recommend",
        transport: "HARNESS_CLI",
        argsRedacted: {},
        requestHash: first.provenance.requestHash,
        dataOrigin: "CACHE",
        cacheSourceInvocationId: sourceId,
        summary: first.envelope,
      });
      const trace = await invocationTrace(db, workspaceId, legacy.id);
      expect(trace.retrievedAt).toEqual(retrievedAt);
      expect(trace.invokedAt).toEqual(legacy.createdAt);
      sourceId = legacy.id;
    }

    const snapshot = await db.execute<{
      raw: unknown;
      raw_retained: boolean;
      result_count: number;
    }>(
      sql`SELECT raw, raw_retained, result_count FROM qloo_response_snapshots WHERE id = ${live!.snapshot_id}`,
    );
    expect(snapshot.rows[0]).toEqual({
      raw: null,
      raw_retained: false,
      result_count: 1,
    });
  });

  it("stops live calls at the conservative daily guard", async () => {
    const transport = new StubLiveTransport();
    const adapter = new QlooAdapter({
      transport,
      harnessVersion: "0.1.26",
      recorder: createDbRecorder(db),
      quota: createDbQuotaGuard(db, { dailyLimit: 2, scopeId: uuidv7() }),
      sleep: async () => {},
    });
    const outcomes = [];
    for (const signal of ["A", "B", "C"]) {
      outcomes.push(
        await adapter.recommend(
          { targetType: "movie", signals: [signal] },
          { projectId, purpose: "quota", cachePolicy: "live-only" },
        ),
      );
    }
    expect(outcomes.map((o) => o.kind)).toEqual(["OK", "OK", "ERROR"]);
    expect(outcomes[2]).toMatchObject({ code: "QUOTA_GUARD_ACTIVE" });
    expect(transport.calls).toBe(2);
  });
});
