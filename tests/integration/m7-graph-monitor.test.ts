import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getExperimentGraph,
  postBrief,
  postProject,
  putGraphLayout,
  startExperiment,
} from "../../apps/web/src/server/api";
import type { Services } from "../../apps/web/src/server/services";
import type { EvidenceGraph } from "../../packages/core/src";
import {
  QUEUES,
  listRunEventsAfter,
  sql,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { apiClient, json, makeServices } from "./helpers/api-client";
import { startBoss } from "./helpers/exploration";
import { syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/** M7: evidence graph API (EG) and the Activity Monitor's data guarantees (AM-A2, AM-A3). */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let s: Services;
let harness: ReturnType<typeof syntheticHarness>;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  s = await makeServices(handle, boss);
  harness = syntheticHarness(handle, boss);
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

/** A full EXPLORATION created through the API and driven to COMPLETED on synthetic data. */
async function completedExperiment() {
  const c = await apiClient(s);
  const project = await json<{ id: string }>(
    await postProject(
      s,
      c.post("/api/v1/projects", { name: "Graph", useCase: "cafe" }),
    ),
  );
  const brief = await json<{ id: string }>(
    await postBrief(
      s,
      c.post(`/api/v1/projects/${project.id}/briefs`, {
        title: "Harbor Lights supper club",
        challenge:
          "A 40-seat supper club wants a monthly night for game, book and film fans.",
        interests: [
          { text: "Stardew Harvest Tales", domainHint: "videogame" },
          { text: "Paper Atlas Stories", domainHint: "book" },
          { text: "Neon Harbor Nights", domainHint: "movie" },
        ],
        venue: { type: "cafe", capacity: 40 },
        constraints: { budgetBand: "low", durationMinutes: 120 },
        goals: ["Attract new weekday visitors"],
      }),
      { projectId: project.id },
    ),
  );
  const started = await json<{ experimentId: string; runId: string }>(
    await startExperiment(
      s,
      c.post(`/api/v1/projects/${project.id}/experiments`, {
        briefVersionId: brief.id,
        mode: "live",
      }),
      { projectId: project.id },
    ),
  );
  const run = await harness.driveToEnd(
    harness.deps("off"),
    { workspaceId: c.workspaceId, ...started },
    { tension: 0.6, select: true },
  );
  expect(run.state).toBe("COMPLETED");
  return { c, ...started };
}

describe("M7 evidence graph API", () => {
  it("projects every hypothesis, claim, and evidence record with provenance; saves the layout", async () => {
    const { c, experimentId } = await completedExperiment();
    const path = `/api/v1/experiments/${experimentId}/graph?include=retired`;
    const res = await getExperimentGraph(s, c.get(path), { experimentId });
    expect(res.status).toBe(200);
    const graph = await json<EvidenceGraph & { layout: unknown }>(res);

    const counts = await handle.db.execute<{ h: string; c: string; e: string }>(
      sql`SELECT (SELECT count(*) FROM hypotheses WHERE experiment_id = ${experimentId})::text AS h,
                 (SELECT count(*) FROM hypothesis_claims hc JOIN hypotheses h ON h.id = hc.hypothesis_id WHERE h.experiment_id = ${experimentId})::text AS c,
                 (SELECT count(*) FROM evidence_records WHERE experiment_id = ${experimentId})::text AS e`,
    );
    const n = (t: string) => graph.nodes.filter((x) => x.type === t).length;
    expect(n("hypothesis")).toBe(Number(counts.rows[0]!.h));
    expect(n("claim")).toBe(Number(counts.rows[0]!.c));
    expect(n("evidence")).toBe(Number(counts.rows[0]!.e));
    for (const node of graph.nodes) {
      if (node.type === "hypothesis")
        expect(node.provenance).toBe("CREATIVE_SPECULATION");
      if (node.type === "claim")
        expect(node.provenance).toBe("MODEL_INTERPRETATION");
      // Synthetic data stays labeled as fixtures end to end, never as Qloo data.
      if (node.type === "evidence" || node.type === "entity")
        expect(node.provenance).toBe("DEVELOPMENT_FIXTURE");
      // EG-A3: every data-backed node can be traced to its invocation.
      if (node.type === "evidence") expect(node.invocationId).toBeTruthy();
    }
    expect(graph.layout).toBeNull();

    const nodeId = graph.nodes[0]!.id;
    const put = await putGraphLayout(
      s,
      c.put(`/api/v1/experiments/${experimentId}/graph-layout`, {
        positions: [{ nodeId, x: 12, y: -34 }],
      }),
      { experimentId },
    );
    expect(put.status).toBe(204);
    const again = await json<{ layout: Record<string, unknown> }>(
      await getExperimentGraph(s, c.get(path), { experimentId }),
    );
    expect(again.layout).toEqual({ [nodeId]: { x: 12, y: -34 } });

    // Workspace isolation and CSRF.
    const other = await apiClient(s);
    expect(
      (await getExperimentGraph(s, other.get(path), { experimentId })).status,
    ).toBe(404);
    expect(
      (
        await putGraphLayout(
          s,
          other.put(`/api/v1/experiments/${experimentId}/graph-layout`, {
            positions: [],
          }),
          { experimentId },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await putGraphLayout(
          s,
          c.put(
            `/api/v1/experiments/${experimentId}/graph-layout`,
            { positions: [] },
            false,
          ),
          { experimentId },
        )
      ).status,
    ).toBe(403);
  });
});

describe("M7 activity monitor data guarantees", () => {
  it("AM-A2: stored events are contiguous; AM-A3: no reasoning content anywhere in events", async () => {
    const { runId } = await completedExperiment();
    const events = await listRunEventsAfter(handle.db, runId, 0, 10_000);
    expect(events.length).toBeGreaterThan(20);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    for (const e of events) walk(e.payload);
    expect(
      [...keys].filter((k) => /think|reasoning|thought|chain/i.test(k)),
    ).toEqual([]);
    for (const e of events) expect(e.summary.length).toBeLessThanOrEqual(280);
    const llm = await handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM llm_invocations WHERE run_id = ${runId} AND output::text ~* '"(thinking|reasoning)"'`,
    );
    expect(Number(llm.rows[0]!.n)).toBe(0);
  });
});
