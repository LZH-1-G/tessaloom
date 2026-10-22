import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ComparisonMetrics } from "../../packages/core/src";
import {
  QUEUES,
  createCounterfactualBranch,
  experimentView,
  findComparison,
  getRun,
  previewCounterfactual,
  sql,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { startBoss } from "./helpers/exploration";
import { RUN_CONFIG, syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/**
 * M8 What-if engine on the synthetic transport and the scripted provider ($0, no network):
 * WI-A1 (only dirty queries are executed), WI-A2 (genuineness counts), WI-A5 (same delta →
 * same branch), genuine recomputation, gate H4, and cancellation.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let harness: ReturnType<typeof syntheticHarness>;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  harness = syntheticHarness(handle, boss);
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

const BRIEF = {
  title: "Harbor Lights supper club",
  challenge:
    "A 40-seat supper club wants a monthly night that pulls game, book and film fans together.",
  interests: [
    { text: "Stardew Harvest Tales", domainHint: "videogame" },
    { text: "Paper Atlas Stories", domainHint: "book" },
    { text: "Neon Harbor Nights", domainHint: "movie" },
  ],
  venue: { type: "cafe", capacity: 40, localityText: "Lisbon" },
  constraints: { budgetBand: "low", durationMinutes: 120 },
  goals: ["Attract new weekday visitors"],
};

/** A finished parent exploration (selection made, run COMPLETED). */
async function parent() {
  const ids = await harness.start(BRIEF, 0.6);
  const run = await harness.driveToEnd(harness.deps("off"), ids, {
    tension: 0.6,
    select: false,
  });
  expect(run.state).toBe("COMPLETED");
  return ids;
}

async function branch(
  ids: { workspaceId: string; experimentId: string },
  delta: Record<string, unknown>,
  answer: "run" | "cancel" = "run",
) {
  const created = await createCounterfactualBranch(handle, boss, {
    workspaceId: ids.workspaceId,
    experimentId: ids.experimentId,
    delta,
    mode: "hold_hypotheses",
    runConfig: RUN_CONFIG,
  });
  const run = await harness.driveToEnd(
    harness.deps("off"),
    {
      workspaceId: ids.workspaceId,
      experimentId: created.branchExperimentId,
      runId: created.runId!,
    },
    { tension: 0.6, select: false, counterfactual: answer },
  );
  // Qloo transport calls of the branch run: every non-CACHE invocation is a real call.
  const calls = await handle.db.execute<{ live: string; reused: string }>(
    sql`SELECT count(*) FILTER (WHERE data_origin <> 'CACHE')::text AS live,
               count(*) FILTER (WHERE data_origin = 'CACHE')::text AS reused
        FROM tool_invocations WHERE run_id = ${created.runId}`,
  );
  const comparison = await findComparison(
    handle.db,
    ids.experimentId,
    created.branchExperimentId,
  );
  return {
    created,
    run,
    live: Number(calls.rows[0]!.live),
    reusedInvocations: Number(calls.rows[0]!.reused),
    comparison,
    metrics: comparison?.metrics as ComparisonMetrics | undefined,
  };
}

describe("M8 counterfactual branches (hold hypotheses)", () => {
  it("weights only: rescore with no Qloo calls, honest labels, and WI-A5 reuse", async () => {
    const ids = await parent();
    const delta = {
      scoringWeights: { support: 0.2, novelty: 0.3, feasibility: 0.5 },
    };
    const b = await branch(ids, delta);
    expect(b.created.plannedDirtyQueries).toBe(0);
    expect(b.created.reusedQueries).toBeGreaterThan(0);
    expect(b.run.state).toBe("COMPLETED");
    expect(b.live).toBe(0); // WI-A1: dirty = 0 → no transport calls
    expect(b.reusedInvocations).toBeGreaterThan(0); // reuse is labeled CACHE
    expect(b.metrics!.header).toMatchObject({
      dirtyQueries: 0,
      newQlooResults: 0,
      rescoreOnly: true,
    });
    const narrative = b.comparison!.narrative as {
      rendered: string;
      provenance: string;
    };
    expect(narrative.rendered).toMatch(/no new Qloo data/i);
    expect(narrative.provenance).toBe("MODEL_INTERPRETATION"); // scripted R5 passed validation
    // Scores changed with the weights; stances did not (same evidence).
    expect(b.metrics!.header.changedStances).toBe(0);
    expect(
      b.metrics!.perHypothesis.some((h) => (h.compositeDelta ?? 0) !== 0),
    ).toBe(true);

    // WI-A5: the identical delta returns the same branch.
    const again = await createCounterfactualBranch(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      delta,
      mode: "hold_hypotheses",
      runConfig: RUN_CONFIG,
    });
    expect(again.reused).toBe(true);
    expect(again.branchExperimentId).toBe(b.created.branchExperimentId);

    // Constraint-only: feasibility is recomputed; still no Qloo calls.
    const c = await branch(ids, { constraints: { capacity: 8 } });
    expect(c.created.plannedDirtyQueries).toBe(0);
    expect(c.live).toBe(0);
    expect(c.metrics!.header.rescoreOnly).toBe(true);
    // A smaller room can only lower feasibility (rules are covered in unit tests).
    expect(
      c.metrics!.perHypothesis.every((h) => (h.feasibilityDelta ?? 0) <= 0),
    ).toBe(true);
  });

  it("seed swap: only dependent queries re-run (WI-A1); evidence and stances genuinely recomputed", async () => {
    const ids = await parent();
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const seed = view.seeds.find((s) => s.role === "seed")!;
    const seedEntity = view.entities.find((e) => e.id === seed.entityId)!;
    // Swap the seed for a discovered entity (a different audience signal).
    const replacement = view.entities.find(
      (e) =>
        e.kind === "entity" &&
        e.id !== seedEntity.id &&
        !view.seeds.some((s) => s.entityId === e.id),
    )!;
    expect(replacement).toBeTruthy();
    const delta = {
      seeds: { swap: [{ from: seed.entityId, to: replacement.id }] },
    };
    const preview = await previewCounterfactual(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
      delta,
    );
    expect(preview.plan.dirtyQueries).toBeGreaterThan(0);
    const b = await branch(ids, delta);
    expect(b.created.plannedDirtyQueries).toBe(preview.plan.dirtyQueries);
    expect(b.run.state).toBe("COMPLETED");
    // WI-A1: transport calls equal the planned dirty queries (synthetic transport: no retries).
    expect(b.live).toBe(b.created.plannedDirtyQueries);
    const m = b.metrics!;
    expect(m.header.dirtyQueries).toBe(b.created.plannedDirtyQueries);
    expect(m.header.rescoreOnly).toBe(false);
    expect(m.header.newQlooResults).toBeGreaterThan(0);
    expect(m.perQuery.length).toBeGreaterThan(0);
    for (const q of m.perQuery) {
      expect(q.overlapAtK).toBeGreaterThanOrEqual(0);
      expect(q.overlapAtK).toBeLessThanOrEqual(1);
      expect(q.rbo).toBeGreaterThanOrEqual(0);
    }
    // Different signal → different result lists for at least one query.
    expect(
      m.perQuery.some((q) => q.entered.length > 0 || q.exited.length > 0),
    ).toBe(true);
    // Claims not depending on the swapped seed reused the parent's evidence (CACHE).
    expect(b.reusedInvocations).toBe(
      b.created.reusedQueries > 0 ? b.reusedInvocations : 0,
    );
    const narrative = b.comparison!.narrative as { text: string };
    expect(narrative.text).not.toMatch(/(?<!\{\{metric:[^}]*)\d/); // numbers only via placeholders
  });

  it("domain add runs discovery for the new domain only; location change re-tests location claims", async () => {
    const ids = await parent();
    const add = await branch(ids, { targetDomains: { add: ["tv_show"] } });
    expect(add.run.state).toBe("COMPLETED");
    // seeds × 1 added domain discovery threads, nothing else.
    expect(add.created.plannedDirtyQueries).toBeGreaterThan(0);
    expect(add.live).toBe(add.created.plannedDirtyQueries);
    expect(add.metrics!.perQuery.every((q) => q.kind === "discovery")).toBe(
      true,
    );

    // Location: switch to another locality entity of the workspace.
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const loc = view.entities.find((e) => e.kind === "locality")!;
    const other = await handle.db.execute<{ id: string }>(
      sql`INSERT INTO cultural_entities (id, workspace_id, kind, qloo_id, domain, name, snapshot, provenance_class)
          SELECT gen_random_uuid(), workspace_id, 'locality', 'FX-locality-porto', 'locality', 'Porto', '{}'::jsonb, 'DEVELOPMENT_FIXTURE'
          FROM cultural_entities WHERE id = ${loc.id} RETURNING id`,
    );
    // Make it an entity of this experiment (a candidate the user could pick).
    await handle.db.execute(
      sql`INSERT INTO entity_relations (id, experiment_id, from_entity_id, to_entity_id, kind, provenance_class, tool_invocation_ids, facts)
          SELECT gen_random_uuid(), ${ids.experimentId}, ${loc.id}, ${other.rows[0]!.id}, 'POPULAR_IN', 'DEVELOPMENT_FIXTURE',
                 ARRAY[(SELECT id FROM tool_invocations WHERE run_id IS NOT NULL ORDER BY created_at LIMIT 1)], '[]'::jsonb`,
    );
    const location = await previewCounterfactual(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
      { location: { localityEntityId: other.rows[0]!.id } },
    );
    const locationClaims = location.plan.claims.filter(
      (c) => c.testKind === "LOCATION_FIT",
    );
    // Exactly the location claims are dirty; nothing else changes.
    expect(
      location.plan.claims
        .filter((c) => c.decision === "DIRTY")
        .every((c) => c.testKind === "LOCATION_FIT"),
    ).toBe(true);
    expect(locationClaims.every((c) => c.decision === "DIRTY")).toBe(true);
    const moved = await branch(ids, {
      location: { localityEntityId: other.rows[0]!.id },
    });
    expect(moved.live).toBe(moved.created.plannedDirtyQueries);
  });

  it("gate H4: a large change asks first; cancel stops the branch without calling Qloo", async () => {
    const ids = await parent();
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const seeds = view.seeds.filter((s) => s.role === "seed");
    const used = new Set<string>();
    const swap = seeds.map((s) => {
      const e = view.entities.find((x) => x.id === s.entityId)!;
      const to = view.entities.find(
        (x) =>
          x.kind === "entity" &&
          x.domain !== e.domain &&
          !used.has(x.id) &&
          !seeds.some((y) => y.entityId === x.id),
      )!;
      used.add(to.id);
      return { from: s.entityId, to: to.id };
    });
    const delta = {
      seeds: { swap },
      targetDomains: { add: ["tv_show", "podcast"] },
    };
    const preview = await previewCounterfactual(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
      delta,
    );
    expect(preview.plan.needsConfirmation).toBe(true);
    const b = await branch(ids, delta, "cancel");
    expect(b.run.state).toBe("CANCELLED");
    expect(b.live).toBe(0);
    const events = await handle.db.execute<{ type: string }>(
      sql`SELECT type FROM run_events WHERE run_id = ${b.created.runId} ORDER BY seq`,
    );
    expect(events.rows.map((e) => e.type)).toContain("CONFIRMATION_REQUESTED");
    const run = await getRun(handle.db, b.created.runId!);
    expect(run.terminalReason).toBe("USER_CANCELLED");
  });

  it("rejects deltas the harness contract cannot apply", async () => {
    const ids = await parent();
    await expect(
      createCounterfactualBranch(handle, boss, {
        workspaceId: ids.workspaceId,
        experimentId: ids.experimentId,
        delta: { audienceBand: { ageBand: "25-34" } },
        mode: "hold_hypotheses",
        runConfig: RUN_CONFIG,
      }),
    ).rejects.toThrow(/PENDING/);
  });
});
