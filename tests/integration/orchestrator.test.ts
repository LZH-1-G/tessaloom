import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  QUEUES,
  confirmRun,
  getRun,
  listRunEventsAfter,
  sql,
  startExploration,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import {
  FixtureLibrary,
  RUN_CONFIG,
  drain,
  makeDeps,
  scriptedExplorationLlm,
  seedProject,
  standardFixtures,
  startBoss,
} from "./helpers/exploration";
import { createTestDatabase } from "./helpers/test-db";

let handle: DbHandle;
let url: string;
let drop: () => Promise<void>;
let boss: PgBoss;
let lib: FixtureLibrary;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  url = test.url;
  drop = test.drop;
  boss = await startBoss(url);
  lib = await FixtureLibrary.create();
  await standardFixtures(lib);
});
// Each test drives its own run; never let one test's leftover jobs reach another's drain.
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
  await lib?.remove();
});

const count = async (query: ReturnType<typeof sql>) =>
  Number((await handle.db.execute<{ n: string }>(query)).rows[0]!.n);

describe("full scripted EXPLORATION (TEST_PLAN §4 item 6)", () => {
  it("runs intent → gates → discovery → pool → loop with one revision → selection → COMPLETED", async () => {
    const { workspace, project, brief } = await seedProject(handle);
    const provider = scriptedExplorationLlm();
    const deps = makeDeps(handle, boss, lib, provider);
    const started = await startExploration(handle, boss, {
      workspaceId: workspace.id,
      projectId: project.id,
      briefVersionId: brief.id,
      mode: "fixture",
      runConfig: RUN_CONFIG,
    });
    expect(started.reused).toBe(false);
    const runId = started.runId;

    // QUEUED → ANALYZING_INTENT → AWAITING_BRIEF_CONFIRMATION (H1)
    await drain(deps);
    let run = await getRun(handle.db, runId);
    expect(run.state).toBe("AWAITING_BRIEF_CONFIRMATION");
    expect(run.pendingConfirmation).toEqual({
      kind: "BRIEF",
      briefVersionId: brief.id,
    });
    await confirmRun(handle, boss, workspace.id, runId, {
      kind: "BRIEF",
      briefVersionId: brief.id,
      action: "confirm",
    });

    // RESOLVING_ENTITIES: "Vangelis" has two candidates → H2
    await drain(deps);
    run = await getRun(handle.db, runId);
    expect(run.state).toBe("AWAITING_ENTITY_CONFIRMATION");
    expect(run.pendingConfirmation).toEqual({
      kind: "ENTITIES",
      interestIndexes: [1],
    });
    await confirmRun(handle, boss, workspace.id, runId, {
      kind: "ENTITIES",
      selections: [
        { interestIndex: 1, choice: { type: "candidate", qlooId: "A-VAN" } },
      ],
    });

    // DISCOVERING → … → EVALUATING (REVISE) → REVISING → … → AWAITING_HYPOTHESIS_SELECTION (H3)
    const outcomes = await drain(deps);
    run = await getRun(handle.db, runId);
    expect(run.state).toBe("AWAITING_HYPOTHESIS_SELECTION");
    expect(
      outcomes.map((o) =>
        o.outcome === "committed" ? `${o.from}>${o.to}` : o.outcome,
      ),
    ).toEqual([
      "DISCOVERING>BUILDING_COLLISION_POOL",
      "BUILDING_COLLISION_POOL>GENERATING_HYPOTHESES",
      "GENERATING_HYPOTHESES>PLANNING_EVIDENCE",
      "PLANNING_EVIDENCE>COLLECTING_EVIDENCE",
      "COLLECTING_EVIDENCE>EVALUATING_EVIDENCE",
      "EVALUATING_EVIDENCE>REVISING_HYPOTHESES",
      "REVISING_HYPOTHESES>PLANNING_EVIDENCE",
      "PLANNING_EVIDENCE>COLLECTING_EVIDENCE",
      "COLLECTING_EVIDENCE>EVALUATING_EVIDENCE",
      "EVALUATING_EVIDENCE>AWAITING_HYPOTHESIS_SELECTION",
    ]);
    expect(run.iteration).toBe(1);
    const pending = run.pendingConfirmation as {
      kind: string;
      hypothesisIds: string[];
    };
    expect(pending.kind).toBe("HYPOTHESIS_SELECTION");

    const hyps = await handle.db.execute<{
      id: string;
      title: string;
      status: string;
      retired: boolean;
      revision_of_id: string | null;
      composite_score: number | null;
    }>(
      sql`SELECT id, title, status, retired, revision_of_id, composite_score FROM hypotheses WHERE run_id = ${runId} ORDER BY created_at, id`,
    );
    const byTitle = Object.fromEntries(hyps.rows.map((h) => [h.title, h]));
    expect(byTitle["Neon noir reading lounge"]).toMatchObject({
      status: "SUPPORTED",
      retired: false,
    });
    expect(byTitle["Synth score supper"]).toMatchObject({
      status: "INCONCLUSIVE",
      retired: true,
    });
    expect(byTitle["Synth score supper (venue test)"]).toMatchObject({
      status: "PARTIALLY_SUPPORTED",
      retired: false,
      revision_of_id: byTitle["Synth score supper"]!.id,
    });
    expect([...pending.hypothesisIds].sort()).toEqual(
      [
        byTitle["Neon noir reading lounge"]!.id,
        byTitle["Synth score supper (venue test)"]!.id,
      ].sort(),
    );

    // H3 → COMPLETED
    await confirmRun(handle, boss, workspace.id, runId, {
      kind: "HYPOTHESIS_SELECTION",
      selectedHypothesisIds: [byTitle["Neon noir reading lounge"]!.id],
    });
    expect(await drain(deps)).toEqual([]); // terminal: nothing enqueued
    run = await getRun(handle.db, runId);
    expect(run.state).toBe("COMPLETED");

    // Persistence (item 6): one state_version per transition, contiguous seq, records exist.
    const events = await listRunEventsAfter(handle.db, runId, 0, 1000);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const entered = events.filter((e) => e.type === "STATE_ENTERED");
    expect(run.stateVersion).toBe(entered.length - 1); // the initial QUEUED entry has no transition
    expect(events.at(-1)!.type).toBe("RUN_COMPLETED");
    for (const e of events) expect(e.summary.length).toBeLessThanOrEqual(280);
    expect(JSON.stringify(events)).not.toMatch(
      /untrusted_input|sk-ant|QLOO_API_KEY/,
    );

    const experimentStatus = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM experiments WHERE id = ${started.experimentId}`,
    );
    expect(experimentStatus.rows[0]!.status).toBe("COMPLETED");
    expect(
      await count(
        sql`SELECT count(*) AS n FROM brief_versions WHERE id = ${brief.id} AND intent_frame IS NOT NULL AND confirmed_at IS NOT NULL`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*) AS n FROM experiment_seeds WHERE experiment_id = ${started.experimentId}`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`SELECT count(*) AS n FROM entity_relations WHERE experiment_id = ${started.experimentId} AND kind = 'THREAD' AND provenance_class = 'DEVELOPMENT_FIXTURE'`,
      ),
    ).toBeGreaterThan(40);
    expect(
      await count(
        sql`SELECT count(*) AS n FROM collision_candidates WHERE experiment_id = ${started.experimentId} AND selected`,
      ),
    ).toBeGreaterThanOrEqual(3);

    // Evidence: deterministic stances, fixture provenance, linked to FIXTURE invocations.
    const evidence = await handle.db.execute<{
      stance: string;
      provenance_class: string;
      data_origin: string;
      ruleset_version: string;
    }>(
      sql`SELECT e.stance, e.provenance_class, t.data_origin, e.ruleset_version FROM evidence_records e JOIN tool_invocations t ON t.id = e.tool_invocation_id WHERE e.run_id = ${runId} ORDER BY e.created_at, e.id`,
    );
    expect(evidence.rows.map((e) => e.stance)).toEqual([
      "SUPPORTS",
      "SUPPORTS",
      "INSUFFICIENT",
      "SUPPORTS",
    ]);
    for (const e of evidence.rows)
      expect(e).toMatchObject({
        provenance_class: "DEVELOPMENT_FIXTURE",
        data_origin: "FIXTURE",
        ruleset_version: "ruleset-2026.10-m4",
      });

    // LLM invocations: R1, R3, R4, R3 (revise), R4 — all VALID, scripted, linked to the run.
    const llm = await handle.db.execute<{
      role: string;
      prompt_id: string;
      validation_status: string;
      provider: string;
    }>(
      sql`SELECT role, prompt_id, validation_status, provider FROM llm_invocations WHERE run_id = ${runId} ORDER BY created_at, id`,
    );
    expect(
      llm.rows.map((r) => `${r.role}:${r.prompt_id}:${r.validation_status}`),
    ).toEqual([
      "R1:r1.intent:VALID",
      "R3:r3.generate:VALID",
      "R4:r4.critique:VALID",
      "R3:r3.revise:VALID",
      "R4:r4.critique:VALID",
    ]);

    // Usage matches the recorded invocations.
    const usage = run.usage as { qlooCalls: number; llmCalls: number };
    const qlooCalls = await count(
      sql`SELECT count(*) AS n FROM tool_invocations WHERE run_id = ${runId} AND data_origin <> 'CACHE'`,
    );
    expect(usage.qlooCalls).toBe(qlooCalls);
    // resolve + seed tags + discovery + tag enrichment + evidence (it. 0) + evidence (it. 1)
    expect(usage.qlooCalls).toBe(2 + 2 + 6 + 8 + 3 + 1);
    expect(usage.llmCalls).toBe(5);
    expect(provider.remaining()).toBe(0);
  });
});

async function startRun() {
  const ids = await seedProject(handle);
  const started = await startExploration(handle, boss, {
    workspaceId: ids.workspace.id,
    projectId: ids.project.id,
    briefVersionId: ids.brief.id,
    mode: "fixture",
    runConfig: RUN_CONFIG,
  });
  return { ...ids, ...started };
}

async function passGates(
  deps: ReturnType<typeof makeDeps>,
  r: Awaited<ReturnType<typeof startRun>>,
) {
  await drain(deps);
  await confirmRun(handle, boss, r.workspace.id, r.runId, {
    kind: "BRIEF",
    briefVersionId: r.brief.id,
    action: "confirm",
  });
  await drain(deps);
  await confirmRun(handle, boss, r.workspace.id, r.runId, {
    kind: "ENTITIES",
    selections: [
      { interestIndex: 1, choice: { type: "candidate", qlooId: "A-VAN" } },
    ],
  });
}

describe("idempotency and recovery (TEST_PLAN §4 items 7–8)", () => {
  it("drops duplicate and stale step jobs without changes", async () => {
    const r = await startRun();
    const deps = makeDeps(handle, boss, lib, scriptedExplorationLlm());
    // The queue already holds run:<id>:0; a duplicate enqueue of the same key is dropped.
    const { enqueueRunStep } = await import("../../packages/db/src");
    expect(
      await enqueueRunStep(boss, { runId: r.runId, expectedStateVersion: 0 }),
    ).toBeNull();
    const { runStep } =
      await import("../../apps/worker/src/orchestrator/runner");
    const job = { runId: r.runId, expectedStateVersion: 0 };
    const first = await runStep(deps, job, { retryCount: 0, retryLimit: 2 });
    expect(first).toMatchObject({
      outcome: "committed",
      from: "QUEUED",
      to: "ANALYZING_INTENT",
    });
    const before = await listRunEventsAfter(handle.db, r.runId, 0, 1000);
    expect(
      await runStep(deps, job, { retryCount: 0, retryLimit: 2 }),
    ).toMatchObject({ outcome: "stale" });
    expect(
      await runStep(
        deps,
        { runId: r.runId, expectedStateVersion: 7 },
        { retryCount: 0, retryLimit: 2 },
      ),
    ).toMatchObject({ outcome: "stale" });
    expect(await listRunEventsAfter(handle.db, r.runId, 0, 1000)).toHaveLength(
      before.length,
    );
    expect((await getRun(handle.db, r.runId)).stateVersion).toBe(1);
  });

  it("re-executes a step that crashed before its commit and commits exactly once", async () => {
    const r = await startRun();
    const provider = scriptedExplorationLlm();
    await passGates(makeDeps(handle, boss, lib, provider), r);
    const qlooBefore = await count(
      sql`SELECT coalesce(sum(value), 0) AS n FROM usage_counters WHERE scope = 'global' AND scope_id = 'qloo'`,
    );
    const { runStep } =
      await import("../../apps/worker/src/orchestrator/runner");
    const run = await getRun(handle.db, r.runId);
    expect(run.state).toBe("DISCOVERING");
    const job = { runId: r.runId, expectedStateVersion: run.stateVersion };
    const crashing = makeDeps(handle, boss, lib, provider, {
      hooks: {
        beforeCommit: () => {
          throw new Error("simulated worker crash");
        },
      },
    });
    await expect(
      runStep(crashing, job, { retryCount: 0, retryLimit: 2 }),
    ).rejects.toThrow("simulated worker crash");
    expect((await getRun(handle.db, r.runId)).stateVersion).toBe(
      run.stateVersion,
    );
    // A restarted worker (fresh adapter, empty cache) retries the job.
    const restarted = makeDeps(handle, boss, lib, provider);
    expect(
      await runStep(restarted, job, { retryCount: 1, retryLimit: 2 }),
    ).toMatchObject({ outcome: "committed", to: "BUILDING_COLLISION_POOL" });
    expect(
      await runStep(restarted, job, { retryCount: 2, retryLimit: 2 }),
    ).toMatchObject({ outcome: "stale" });
    const entered = await count(
      sql`SELECT count(*) AS n FROM run_events WHERE run_id = ${r.runId} AND type = 'STATE_ENTERED' AND state = 'BUILDING_COLLISION_POOL'`,
    );
    expect(entered).toBe(1);
    // Quota counters include both attempts (2 seed tags + 6 threads + 8 enrichments each).
    const qlooAfter = await count(
      sql`SELECT coalesce(sum(value), 0) AS n FROM usage_counters WHERE scope = 'global' AND scope_id = 'qloo'`,
    );
    expect(qlooAfter - qlooBefore).toBe(32);
    expect(
      await count(
        sql`SELECT count(*) AS n FROM tool_invocations WHERE run_id = ${r.runId} AND method = 'recommend'`,
      ),
    ).toBe(12);
    // Run usage counts the committed attempt only.
    expect(
      ((await getRun(handle.db, r.runId)).usage as { qlooCalls: number })
        .qlooCalls,
    ).toBe(2 + 16);
  });
});

describe("cancellation, expiry, and budgets (TEST_PLAN §4 items 9–10, §8)", () => {
  it("aborts an in-flight evidence call, keeps committed records, and enqueues nothing more", async () => {
    const r = await startRun();
    const provider = scriptedExplorationLlm();
    const base = makeDeps(handle, boss, lib, provider);
    const { requestRunCancel } = await import("../../packages/db/src");
    let intercepted = 0;
    const adapter = base.ports.qloo;
    const qloo = Object.assign(Object.create(adapter) as typeof adapter, {
      recommend: async (
        input: Parameters<typeof adapter.recommend>[0],
        ctx: Parameters<typeof adapter.recommend>[1],
      ) => {
        if (input.limit === 20 && intercepted++ === 0) {
          // The user cancels while the first evidence call is in flight.
          await requestRunCancel(handle.db, r.runId);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return adapter.recommend(input, ctx);
      },
    });
    const ports = { ...base.ports, qloo };
    const deps = { ...base, ports };
    await passGates(deps, r);
    await drain(deps);
    const run = await getRun(handle.db, r.runId);
    expect(run.state).toBe("CANCELLED");
    expect(run.terminalReason).toBe("USER_CANCELLED");
    expect(intercepted).toBe(1); // no further evidence calls after the abort
    expect(
      await count(
        sql`SELECT count(*) AS n FROM hypotheses WHERE run_id = ${r.runId}`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`SELECT count(*) AS n FROM evidence_records WHERE run_id = ${r.runId}`,
      ),
    ).toBe(0);
    const events = await listRunEventsAfter(handle.db, r.runId, 0, 1000);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_CANCELLED",
      summary: "Run cancelled — evidence incomplete",
    });
    expect(await drain(deps)).toEqual([]);
  });

  it("expires a run paused for more than 24 hours", async () => {
    const r = await startRun();
    await drain(makeDeps(handle, boss, lib, scriptedExplorationLlm()));
    expect((await getRun(handle.db, r.runId)).state).toBe(
      "AWAITING_BRIEF_CONFIRMATION",
    );
    const { expirePausedRuns } =
      await import("../../apps/worker/src/orchestrator/maintenance");
    expect(
      await expirePausedRuns(handle, new Date(Date.now() + 23 * 3_600_000)),
    ).toBe(0);
    expect(
      await expirePausedRuns(handle, new Date(Date.now() + 25 * 3_600_000)),
    ).toBeGreaterThanOrEqual(1);
    const run = await getRun(handle.db, r.runId);
    expect(run).toMatchObject({
      state: "CANCELLED",
      terminalReason: "EXPIRED",
      pendingConfirmation: null,
    });
  });

  it("ends with COMPLETED_WITH_LIMITS and UNTESTED_BUDGET claims when the Qloo budget runs out", async () => {
    const r = await startRun();
    // Resolution (2) + seed tags (2) + threads (6) use all 10 calls (enrichment yields to the
    // evidence reserve); no evidence query fits.
    await handle.db.execute(
      sql`UPDATE agent_runs SET budget = jsonb_set(budget, '{maxQlooCalls}', '10') WHERE id = ${r.runId}`,
    );
    const deps = makeDeps(handle, boss, lib, scriptedExplorationLlm());
    await passGates(deps, r);
    await drain(deps);
    const run = await getRun(handle.db, r.runId);
    expect(run).toMatchObject({
      state: "COMPLETED_WITH_LIMITS",
      terminalReason: "BUDGET:maxQlooCalls",
    });
    const claims = await handle.db.execute<{ status: string }>(
      sql`SELECT c.status FROM hypothesis_claims c JOIN hypotheses h ON h.id = c.hypothesis_id WHERE h.run_id = ${r.runId}`,
    );
    expect(claims.rows.map((c) => c.status).sort()).toEqual([
      "UNTESTED_BUDGET",
      "UNTESTED_BUDGET",
      "UNTESTED_BUDGET",
    ]);
    const events = await listRunEventsAfter(handle.db, r.runId, 0, 1000);
    expect(events.map((e) => e.type)).toContain("BUDGET_EXHAUSTED");
    expect(events.at(-1)).toMatchObject({ type: "RUN_COMPLETED" });
  });
});
