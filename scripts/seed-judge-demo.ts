/** Local preparation only: the same real pipeline as regression tests, fixed synthetic ports.
 * Requires an empty, migrated local demo database. Never run inside a public service.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { JUDGE_BRIEF } from "../apps/web/src/lib/judge-scenario";
import {
  createDb,
  sql,
  experimentView,
  createCounterfactualBranch,
  startComposition,
  createProjectShareLink,
  setSampleFeatured,
  globalLlmSpendToday,
} from "../packages/db/src";
import { startBoss } from "../tests/integration/helpers/exploration";
import {
  syntheticHarness,
  RUN_CONFIG,
} from "../tests/integration/helpers/synthetic";

async function main() {
  const raw = process.env.DATABASE_URL;
  assert(
    raw,
    "Set DATABASE_URL to an empty migrated local tessaloom_demo database",
  );
  const url = new URL(raw);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(/^\/tessaloom_demo(?:_[a-z0-9_]+)?$/.test(url.pathname));
  assert(!["production", "staging"].includes(process.env.APP_ENV ?? ""));
  assert(
    !Object.entries(process.env).some(([k, v]) => /API_KEY$/.test(k) && v),
  );
  assert(!process.env.DATABASE_URL_MIGRATOR);
  // No HTTP, regardless of inherited defaults. PostgreSQL remains local.
  globalThis.fetch = async () => {
    throw new Error("Demo preparation forbids HTTP");
  };
  process.env.APP_ENV = "test";
  process.env.RUN_ACCESS = "off";
  process.env.GLOBAL_DAILY_LLM_USD = "0";
  process.env.GLOBAL_DAILY_QLOO_CALLS = "0";
  const handle = createDb(raw, { applicationName: "tessaloom-judge-fixture" });
  let boss: Awaited<ReturnType<typeof startBoss>> | undefined;
  try {
    const count = await handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text n FROM workspaces`,
    );
    assert.equal(
      count.rows[0]!.n,
      "0",
      "Refusing to change a populated database",
    );
    boss = await startBoss(raw);
    const harness = syntheticHarness(handle, boss);
    const ids = await harness.start(JUDGE_BRIEF, 0.6);
    const finished = await harness.driveToEnd(harness.deps("off"), ids, {
      tension: 0.6,
      select: true,
    });
    assert.equal(finished.state, "COMPLETED");
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const projectId = view.experiment.projectId;
    await handle.db.execute(
      sql`UPDATE projects SET name = 'Harbor Lights — FIXTURE demonstration' WHERE id = ${projectId}`,
    );
    const branch = await createCounterfactualBranch(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      delta: {
        scoringWeights: { support: 0.2, novelty: 0.3, feasibility: 0.5 },
      },
      mode: "hold_hypotheses",
      runConfig: RUN_CONFIG,
    });
    assert(branch.runId);
    const branchRun = await harness.driveToEnd(
      harness.deps("off"),
      {
        workspaceId: ids.workspaceId,
        experimentId: branch.branchExperimentId,
        runId: branch.runId,
      },
      { tension: 0.6, select: false },
    );
    assert.equal(branchRun.state, "COMPLETED");
    const branchView = await experimentView(
      handle.db,
      ids.workspaceId,
      branch.branchExperimentId,
    );
    const composed = await startComposition(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: branch.branchExperimentId,
      hypothesisIds: branchView.hypotheses
        .filter((h) => !h.retired)
        .slice(0, 1)
        .map((h) => h.id),
      format: "event",
      runConfig: RUN_CONFIG,
    });
    const compositionRun = await harness.driveToEnd(
      harness.deps("off"),
      {
        workspaceId: ids.workspaceId,
        experimentId: branch.branchExperimentId,
        runId: composed.runId,
      },
      { tension: 0.6, select: false },
    );
    assert.equal(compositionRun.state, "COMPLETED");
    const samples = [];
    for (const scope of ["project", "blueprint"] as const) {
      const link = await createProjectShareLink(handle.db, {
        workspaceId: ids.workspaceId,
        projectId,
        scope,
        targetId: scope === "project" ? projectId : composed.blueprintId,
        tokenHash: randomBytes(32).toString("hex"),
        expiresInDays: 60,
      });
      // No usable bearer token is created or printed. Featured sample IDs are public by design.
      await setSampleFeatured(handle.db, link.id, true);
      samples.push({
        scope,
        path: `/samples/${link.id}`,
        expiresAt: link.expiresAt,
      });
    }
    const origins = await handle.db.execute<{ bad: string }>(
      sql`SELECT count(*)::text bad FROM tool_invocations WHERE data_origin NOT IN ('FIXTURE','CACHE')`,
    );
    assert.equal(origins.rows[0]!.bad, "0");
    assert.equal(await globalLlmSpendToday(handle.db), 0);
    console.log(
      JSON.stringify(
        {
          event: "judge_demo_prepared",
          label: "FIXTURE — not real Qloo data",
          ai: "scripted",
          httpRequests: 0,
          providerCostUsd: 0,
          samples,
        },
        null,
        2,
      ),
    );
  } finally {
    await boss?.stop({ graceful: false });
    await handle.close();
  }
}
main().catch(() => {
  console.error(
    "Judge demo preparation failed. Check local empty-database and credential-isolation prerequisites; no raw error or credentials logged.",
  );
  process.exitCode = 1;
});
