import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import {
  getProjectDetail,
  getRunAccess,
  postBrief,
  postProject,
  postRunAccess,
  startExperiment,
} from "../../apps/web/src/server/api";
import {
  getSample,
  getSamples,
  postShareLink,
} from "../../apps/web/src/server/blueprints";
import { RateLimiter } from "../../apps/web/src/server/http";
import type { Services } from "../../apps/web/src/server/services";
import {
  LLM_SPEND_METRIC,
  MAX_MANUAL_RETRIES,
  QUEUES,
  createDemoGrant,
  createProjectShareLink,
  experimentView,
  getUsage,
  hashDemoCode,
  reserveLlmSpend,
  retryRun,
  revokeDemoGrant,
  setSampleFeatured,
  settleLlmSpend,
  sql,
  utcDay,
  type DbHandle,
  type LlmSpendLimits,
  type PgBoss,
  type RunAdmission,
} from "../../packages/db/src";
import {
  LlmGateway,
  GeminiProvider,
  DeepSeekProvider,
  deepseekUsdPrices,
  ProviderError,
  ScriptedLlmProvider,
} from "../../packages/llm-gateway/src";
import {
  createSpendGuard,
  createDbLlmRecorder,
} from "../../apps/worker/src/llm";
import { ORIGIN, apiClient, json, makeServices } from "./helpers/api-client";
import { startBoss } from "./helpers/exploration";
import { syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/**
 * M10-A public demo cost safety: the spend ledger, run admission, demo access grants, retry
 * limits, and read-only samples. Synthetic data and a scripted provider only: no paid calls.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let harness: ReturnType<typeof syntheticHarness>;
let base: Services;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  base = await makeServices(handle, boss);
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
  ],
  venue: { type: "cafe", capacity: 40 },
  goals: ["Attract new weekday visitors"],
};

const OPEN: LlmSpendLimits = {
  access: "open",
  globalDailyUsd: 1000,
  workspaceDailyUsd: 1000,
  experimentUsd: 1000,
};

const counter = (
  scope: "global" | "workspace" | "experiment" | "run" | "grant",
  scopeId: string,
  day = "total",
) => getUsage(handle.db, { scope, scopeId, metric: LLM_SPEND_METRIC, day });

async function freshGlobalDay() {
  await handle.db.execute(
    sql`DELETE FROM usage_counters WHERE scope = 'global' AND metric = ${LLM_SPEND_METRIC}`,
  );
}

describe("spend ledger (atomic reservations before provider calls)", () => {
  it("parallel reservations never exceed the global daily cap", async () => {
    await freshGlobalDay();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => harness.start(BRIEF)),
    );
    // Cap $1.00; each attempt reserves $0.15 → at most 6 of 24 parallel attempts fit.
    const limits = { ...OPEN, globalDailyUsd: 1 };
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        reserveLlmSpend(handle, {
          runId: runs[i % 4]!.runId,
          model: "claude-opus-5-5",
          upperBoundUsd: 0.15,
          limits,
        }),
      ),
    );
    const granted = results.filter((r) => r.ok);
    expect(granted).toHaveLength(6);
    expect(
      results
        .filter((r) => !r.ok)
        .every((r) => !r.ok && r.code === "GLOBAL_BUDGET"),
    ).toBe(true);
    expect(await counter("global", "all", utcDay())).toBe(900_000);
  });

  it("settles to the actual cost, keeps the full reservation when the outcome is unknown, and settles once", async () => {
    await freshGlobalDay();
    const { runId } = await harness.start(BRIEF);
    const a = await reserveLlmSpend(handle, {
      runId,
      model: "m",
      upperBoundUsd: 0.5,
      limits: OPEN,
    });
    const b = await reserveLlmSpend(handle, {
      runId,
      model: "m",
      upperBoundUsd: 0.5,
      limits: OPEN,
    });
    if (!a.ok || !b.ok) throw new Error("reservations should succeed");
    expect(await counter("run", runId)).toBe(1_000_000);
    await settleLlmSpend(handle, a.reservationId, 0.12);
    await settleLlmSpend(handle, a.reservationId, 0); // second settle is a no-op
    await settleLlmSpend(handle, b.reservationId, null); // provider threw: unknown outcome
    expect(await counter("run", runId)).toBe(620_000);
    expect(await counter("global", "all", utcDay())).toBe(620_000);
    const rows = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM llm_spend_reservations WHERE run_id = ${runId} ORDER BY created_at, id`,
    );
    expect(rows.rows.map((r) => r.status).sort()).toEqual([
      "SETTLED",
      "UNKNOWN",
    ]);
  });

  it("re-executed steps (crash before commit, stale job, recovery) cannot exceed the run and experiment caps", async () => {
    const { runId, experimentId } = await harness.start(BRIEF);
    // The run's committed usage stays 0 (the step never committed), but the ledger remembers.
    const tries = [];
    for (let i = 0; i < 6; i++)
      tries.push(
        await reserveLlmSpend(handle, {
          runId,
          model: "m",
          upperBoundUsd: 0.5,
          limits: OPEN,
        }),
      );
    // EXPLORATION budget is $2.00 → four $0.50 attempts fit, then the run cap refuses.
    expect(tries.filter((t) => t.ok)).toHaveLength(4);
    expect(tries.at(-1)).toMatchObject({ ok: false, code: "RUN_BUDGET" });
    const usage = await handle.db.execute<{ cost: string | null }>(
      sql`SELECT usage->>'estimatedCostUsd' AS cost FROM agent_runs WHERE id = ${runId}`,
    );
    expect(Number(usage.rows[0]!.cost ?? 0)).toBe(0);
    // A second run on the same experiment is bounded by the experiment cap.
    const second = await handle.db.execute<{ id: string }>(sql`
      INSERT INTO agent_runs (id, experiment_id, kind, state, budget, usage, config_snapshot, trace_id)
      SELECT gen_random_uuid(), experiment_id, kind, 'QUEUED', budget, usage, config_snapshot, trace_id
      FROM agent_runs WHERE id = ${runId} RETURNING id`);
    const capped = await reserveLlmSpend(handle, {
      runId: second.rows[0]!.id,
      model: "m",
      upperBoundUsd: 0.5,
      limits: { ...OPEN, experimentUsd: 2.25 },
    });
    expect(capped).toMatchObject({ ok: false, code: "EXPERIMENT_BUDGET" });
    expect(await counter("experiment", experimentId)).toBe(2_000_000);
  });

  it("cancelled and finished runs cannot reserve, and refusals roll back every counter", async () => {
    const { runId, workspaceId } = await harness.start(BRIEF);
    const before = await counter("workspace", workspaceId, utcDay());
    await handle.db.execute(
      sql`UPDATE agent_runs SET cancel_requested_at = now() WHERE id = ${runId}`,
    );
    expect(
      await reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: 0.1,
        limits: OPEN,
      }),
    ).toMatchObject({ ok: false, code: "RUN_STOPPED" });
    const done = await harness.start(BRIEF);
    await handle.db.execute(
      sql`UPDATE agent_runs SET state = 'COMPLETED' WHERE id = ${done.runId}`,
    );
    expect(
      await reserveLlmSpend(handle, {
        runId: done.runId,
        model: "m",
        upperBoundUsd: 0.1,
        limits: OPEN,
      }),
    ).toMatchObject({ ok: false, code: "RUN_STOPPED" });
    // Workspace cap refusal after the global cap was already consumed in the same transaction.
    const other = await harness.start(BRIEF);
    const g0 = await counter("global", "all", utcDay());
    expect(
      await reserveLlmSpend(handle, {
        runId: other.runId,
        model: "m",
        upperBoundUsd: 0.4,
        limits: { ...OPEN, workspaceDailyUsd: 0.3 },
      }),
    ).toMatchObject({ ok: false, code: "WORKSPACE_BUDGET" });
    expect(await counter("global", "all", utcDay())).toBe(g0);
    expect(await counter("workspace", workspaceId, utcDay())).toBe(before);
  });

  it("invite mode: anonymous workspaces cannot spend; a grant can, within its own cap; revocation is immediate; off stops everything", async () => {
    const { runId, workspaceId } = await harness.start(BRIEF);
    const invite = { ...OPEN, access: "invite" as const };
    expect(
      await reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: 0.1,
        limits: invite,
      }),
    ).toMatchObject({ ok: false, code: "RUN_ACCESS_REQUIRED" });
    const grant = await createDemoGrant(handle.db, {
      label: "judge-1",
      codeHash: hashDemoCode("ledger-test-code-0001", base.pepper),
      expiresAt: new Date(Date.now() + 86_400_000),
      maxRuns: 5,
      maxLlmUsd: 0.25,
    });
    await handle.db.execute(
      sql`UPDATE workspaces SET demo_grant_id = ${grant.id} WHERE id = ${workspaceId}`,
    );
    const ok = await reserveLlmSpend(handle, {
      runId,
      model: "m",
      upperBoundUsd: 0.2,
      limits: invite,
    });
    expect(ok.ok).toBe(true);
    expect(
      await reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: 0.1,
        limits: invite,
      }),
    ).toMatchObject({ ok: false, code: "GRANT_BUDGET" });
    expect(await revokeDemoGrant(handle.db, grant.id)).toBe(true);
    expect(
      await reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: 0.01,
        limits: invite,
      }),
    ).toMatchObject({ ok: false, code: "RUN_ACCESS_REQUIRED" });
    expect(
      await reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: 0,
        limits: { ...OPEN, access: "off" },
      }),
    ).toMatchObject({ ok: false, code: "PAID_RUNS_DISABLED" });
  });
});

describe("gateway + worker spend guard", () => {
  const Out = z.object({
    answer: z.string().min(1),
    decisionSummary: z.string(),
  });
  const good = { answer: "ok", decisionSummary: "Answered." };
  const request = (runId: string | null) => ({
    role: "R1" as const,
    promptId: "r1.intent",
    input: { brief: "A cafe wants a film-and-food night" },
    schema: Out,
    effort: "low" as const,
    maxOutputTokens: 1000,
    ctx: { projectId: "p", runId },
  });
  const gatewayWith = (provider: ScriptedLlmProvider, limits: LlmSpendLimits) =>
    new LlmGateway({
      provider,
      primaryModel: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
      spendGuard: createSpendGuard(handle, limits),
      now: () => 0,
    });

  it("reserves every attempt (repair included), settles to the actual cost, and stops before the provider when exhausted", async () => {
    await freshGlobalDay();
    const { runId } = await harness.start(BRIEF);
    const provider = new ScriptedLlmProvider().on(
      "r1.intent",
      {
        output: { answer: "" },
        usage: { inputTokens: 1000, outputTokens: 100 },
      },
      { output: good, usage: { inputTokens: 1200, outputTokens: 200 } },
    );
    const result = await gatewayWith(provider, OPEN).generate(request(runId));
    expect(result.ok).toBe(true);
    expect(provider.requests).toHaveLength(2);
    const rows = await handle.db.execute<{ status: string; actual: string }>(
      sql`SELECT status, actual_micros AS actual FROM llm_spend_reservations WHERE run_id = ${runId}`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.status === "SETTLED")).toBe(true);
    expect(await counter("run", runId)).toBe(
      rows.rows.reduce((n, r) => n + Number(r.actual), 0),
    );

    // Exhausted global budget: the call fails gracefully with BUDGET and the provider is never called.
    const idle = new ScriptedLlmProvider().on("r1.intent", { output: good });
    const denied = await gatewayWith(idle, {
      ...OPEN,
      globalDailyUsd: 0.0001,
    }).generate(request(runId));
    expect(denied).toMatchObject({ ok: false, reason: "BUDGET" });
    expect(idle.requests).toHaveLength(0);

    // No run context → refused (fail-closed), still without a provider call.
    const orphan = await gatewayWith(idle, OPEN).generate(request(null));
    expect(orphan).toMatchObject({ ok: false, reason: "BUDGET" });
    expect(idle.requests).toHaveLength(0);
  });

  it("a provider failure keeps the full reservation charged (unknown billing)", async () => {
    const { runId } = await harness.start(BRIEF);
    const provider = new ScriptedLlmProvider().on(
      "r1.intent",
      { error: new ProviderError("unavailable", "busy", true) },
      { error: new ProviderError("unavailable", "busy", true) },
    );
    const result = await gatewayWith(provider, OPEN).generate(request(runId));
    expect(result.ok).toBe(false);
    const rows = await handle.db.execute<{ status: string; reserved: string }>(
      sql`SELECT status, reserved_micros AS reserved FROM llm_spend_reservations WHERE run_id = ${runId}`,
    );
    expect(rows.rows).toHaveLength(2); // primary + fallback attempt, each reserved
    expect(rows.rows.every((r) => r.status === "UNKNOWN")).toBe(true);
    expect(await counter("run", runId)).toBe(
      rows.rows.reduce((n, r) => n + Number(r.reserved), 0),
    );
  });
});

describe("run admission, demo access, and abuse limits (API)", () => {
  const withAdmission = (admission: Partial<RunAdmission>): Services => ({
    ...base,
    limiter: new RateLimiter(),
    admission: { ...base.admission, ...admission },
  });

  async function projectWithBrief(s: Services) {
    const c = await apiClient(s);
    const project = await json<{ id: string }>(
      await postProject(
        s,
        c.post("/api/v1/projects", { name: "Cost", useCase: "cafe" }),
      ),
    );
    const brief = await json<{ id: string }>(
      await postBrief(
        s,
        c.post(`/api/v1/projects/${project.id}/briefs`, BRIEF),
        {
          projectId: project.id,
        },
      ),
    );
    // Distinct variables per start → a distinct experiment each time (no idempotent reuse).
    let n = 0;
    const start = () =>
      startExperiment(
        s,
        c.post(`/api/v1/projects/${project.id}/experiments`, {
          briefVersionId: brief.id,
          mode: "live",
          variables: { collisionTension: 0.2 + (n++ % 70) / 100 },
        }),
        { projectId: project.id },
      );
    return { c, projectId: project.id, start };
  }

  const runCount = async (workspaceId: string) =>
    Number(
      (
        await handle.db.execute<{ n: string }>(sql`
          SELECT count(*) AS n FROM agent_runs r JOIN experiments e ON e.id = r.experiment_id
          JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = ${workspaceId}`)
      ).rows[0]!.n,
    );

  it("refuses anonymous paid runs in invite mode; a redeemed code unlocks; brute force is limited; revocation is immediate", async () => {
    const s = withAdmission({ access: "invite" });
    const { c, projectId, start } = await projectWithBrief(s);
    const refused = await start();
    expect(refused.status).toBe(403);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
      "RUN_ACCESS_REQUIRED",
    );
    expect(await runCount(c.workspaceId)).toBe(0);
    // The rest of the site keeps working.
    expect(
      (
        await getProjectDetail(s, c.get(`/api/v1/projects/${projectId}`), {
          projectId,
        })
      ).status,
    ).toBe(200);
    expect(
      await json<{ allowed: boolean; access: string }>(
        await getRunAccess(s, c.get("/api/v1/workspace/access")),
      ),
    ).toMatchObject({ access: "invite", allowed: false });

    // Wrong codes: uniform 400, then 429 after 10 attempts.
    for (let i = 0; i < 10; i++)
      expect(
        (
          await postRunAccess(
            s,
            c.post("/api/v1/workspace/access", {
              code: `wrong-code-attempt-${i}`,
            }),
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await postRunAccess(
          s,
          c.post("/api/v1/workspace/access", { code: "wrong-code-attempt-x" }),
        )
      ).status,
    ).toBe(429);

    const code = "valid-demo-code-for-judges-001";
    const grant = await createDemoGrant(handle.db, {
      label: "judge-2",
      codeHash: hashDemoCode(code, s.pepper),
      expiresAt: new Date(Date.now() + 86_400_000),
      maxRuns: 1,
      maxLlmUsd: 1,
    });
    const s2 = { ...s, limiter: new RateLimiter() };
    const redeemed = await postRunAccess(
      s2,
      c.post("/api/v1/workspace/access", { code }),
    );
    expect(redeemed.status).toBe(200);
    expect(await json<{ allowed: boolean }>(redeemed)).toMatchObject({
      allowed: true,
    });
    expect((await start()).status).toBe(202);
    // The grant allows one run: the second is refused and leaves no run behind.
    const second = await start();
    expect(second.status).toBe(429);
    expect(await runCount(c.workspaceId)).toBe(1);
    await revokeDemoGrant(handle.db, grant.id);
    expect((await start()).status).toBe(403);
  });

  it("the kill switch stops new runs while saved work and samples stay available", async () => {
    const s = withAdmission({ access: "off" });
    const { c, projectId, start } = await projectWithBrief(s);
    const res = await start();
    expect(res.status).toBe(503);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "PAID_RUNS_DISABLED",
    );
    expect(
      (
        await getProjectDetail(s, c.get(`/api/v1/projects/${projectId}`), {
          projectId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await getSamples(s, new Request(`${ORIGIN}/api/v1/samples`))).status,
    ).toBe(200);
  });

  it("parallel starts cannot exceed the per-workspace concurrency limit", async () => {
    const s = withAdmission({ access: "open", maxActivePerWorkspace: 2 });
    const { c, start } = await projectWithBrief(s);
    const results = await Promise.all(Array.from({ length: 6 }, () => start()));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 202)).toHaveLength(2);
    expect(statuses.filter((x) => x === 429)).toHaveLength(4);
    expect(await runCount(c.workspaceId)).toBe(2);
  });

  it("the daily run allowance and the global working-run limit are enforced", async () => {
    const daily = withAdmission({ access: "open", dailyRunsPerWorkspace: 1 });
    const a = await projectWithBrief(daily);
    expect((await a.start()).status).toBe(202);
    expect((await a.start()).status).toBe(429);
    const busy = withAdmission({ access: "open", maxWorkingGlobal: 0 });
    const b = await projectWithBrief(busy);
    const res = await b.start();
    expect(res.status).toBe(503);
    expect(
      (await json<{ error: { code: string; retryable: boolean } }>(res)).error,
    ).toMatchObject({
      code: "BUSY",
      retryable: true,
    });
  });
});

describe("retries and read-only samples", () => {
  it("project sample projections retain fixture provenance and cannot bypass production denial", async () => {
    const ids = await harness.start(BRIEF);
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const link = await createProjectShareLink(handle.db, {
      workspaceId: ids.workspaceId,
      projectId: view.experiment.projectId,
      scope: "project",
      targetId: view.experiment.projectId,
      tokenHash: "f".repeat(64),
      expiresInDays: 1,
    });
    await setSampleFeatured(handle.db, link.id, true);
    const req = () => new Request(`${ORIGIN}/api/v1/samples/${link.id}`);
    const local = await getSample(base, req(), { sampleId: link.id });
    expect(local.status).toBe(200);
    expect(await local.text()).toContain('"DEVELOPMENT_FIXTURE"');
    const listed = await json<{ items: { id: string; fixture: boolean }[] }>(
      await getSamples(base, req()),
    );
    expect(listed.items.find((s) => s.id === link.id)?.fixture).toBe(true);
    const denied = await getSample({ ...base, appEnv: "production" }, req(), {
      sampleId: link.id,
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(view.experiment.projectId);
    const productionList = await getSamples(
      { ...base, appEnv: "production" },
      req(),
    );
    expect(await productionList.text()).not.toContain(link.id);
    await setSampleFeatured(handle.db, link.id, false);
  });
  it(`a run cannot be retried more than ${MAX_MANUAL_RETRIES} times`, async () => {
    const { runId, workspaceId } = await harness.start(BRIEF);
    const fail = () =>
      handle.db.execute(sql`
        UPDATE agent_runs SET state = 'FAILED', state_version = state_version + 1,
          error = '{"transient": true, "failedState": "RESOLVING_ENTITIES", "code": "X"}'::jsonb
        WHERE id = ${runId}`);
    for (let i = 0; i < MAX_MANUAL_RETRIES; i++) {
      await fail();
      await retryRun(handle, boss, workspaceId, runId);
    }
    await fail();
    await expect(retryRun(handle, boss, workspaceId, runId)).rejects.toThrow(
      /already retried/,
    );
  });

  it("featured samples are readable without a workspace and never start a run", async () => {
    const s = { ...base, limiter: new RateLimiter() };
    const c = await apiClient(s);
    const project = await json<{ id: string }>(
      await postProject(
        s,
        c.post("/api/v1/projects", { name: "Sample night", useCase: "cafe" }),
      ),
    );
    const link = await json<{ shareLinkId: string }>(
      await postShareLink(
        s,
        c.post(`/api/v1/projects/${project.id}/share-links`, {
          scope: "project",
          targetId: project.id,
          expiresInDays: 90,
        }),
        { projectId: project.id },
      ),
    );
    const anonymous = (path: string) => new Request(`${ORIGIN}${path}`);
    const before = await handle.db.execute<{ runs: string; llm: string }>(
      sql`SELECT (SELECT count(*) FROM agent_runs) AS runs, (SELECT count(*) FROM llm_invocations) AS llm`,
    );
    // Not featured → not listed and not readable by id.
    expect(
      (
        await json<{ items: { id: string }[] }>(
          await getSamples(s, anonymous("/api/v1/samples")),
        )
      ).items.map((i) => i.id),
    ).not.toContain(link.shareLinkId);
    expect(
      (await getSample(s, anonymous("/x"), { sampleId: link.shareLinkId }))
        .status,
    ).toBe(404);
    await setSampleFeatured(handle.db, link.shareLinkId, true);
    const listed = await json<{ items: { id: string; projectName: string }[] }>(
      await getSamples(s, anonymous("/api/v1/samples")),
    );
    expect(listed.items).toContainEqual(
      expect.objectContaining({
        id: link.shareLinkId,
        projectName: "Sample night",
      }),
    );
    const view = await getSample(s, anonymous("/x"), {
      sampleId: link.shareLinkId,
    });
    expect(view.status).toBe(200);
    const text = JSON.stringify(await view.json());
    expect(text).not.toContain(c.workspaceId);
    expect(text).not.toContain(project.id);
    const after = await handle.db.execute<{ runs: string; llm: string }>(
      sql`SELECT (SELECT count(*) FROM agent_runs) AS runs, (SELECT count(*) FROM llm_invocations) AS llm`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    // Public visibility is explicit and revocable; private projects and link hashes stay private.
    const privateProject = await json<{ id: string }>(
      await postProject(
        s,
        c.post("/api/v1/projects", {
          name: "PRIVATE-DO-NOT-PUBLISH",
          useCase: "cafe",
        }),
      ),
    );
    const listingText = await (
      await getSamples(s, anonymous("/api/v1/samples"))
    ).text();
    expect(listingText).not.toContain("PRIVATE-DO-NOT-PUBLISH");
    expect(listingText).not.toContain(privateProject.id);
    expect(text).not.toMatch(
      /tokenHash|codeHash|demoGrantId|secretHash|workspaceId|toolInvocationId/,
    );
    await handle.db.execute(
      sql`UPDATE share_links SET revoked_at = now() WHERE id = ${link.shareLinkId}`,
    );
    expect(
      (await getSample(s, anonymous("/x"), { sampleId: link.shareLinkId }))
        .status,
    ).toBe(404);
    await handle.db.execute(
      sql`UPDATE share_links SET revoked_at = NULL, expires_at = now() - interval '1 second' WHERE id = ${link.shareLinkId}`,
    );
    expect(
      (await getSample(s, anonymous("/x"), { sampleId: link.shareLinkId }))
        .status,
    ).toBe(404);
  });
});

describe("durable fail-closed accounting", () => {
  it("limits calls and tokens across repeated execution even when costs are zero", async () => {
    const { runId } = await harness.start(BRIEF);
    await handle.db.execute(
      sql`UPDATE agent_runs SET budget = budget || '{"maxLlmCalls":2,"maxLlmOutputTokens":100}'::jsonb WHERE id = ${runId}`,
    );
    const reserve = (tokens: number) =>
      reserveLlmSpend(handle, {
        runId,
        model: "scripted",
        upperBoundUsd: 0,
        maxOutputTokens: tokens,
        limits: OPEN,
      });
    const a = await reserve(60);
    expect(a.ok).toBe(true);
    // A lost process has not settled: its allowance remains consumed.
    expect(await reserve(60)).toMatchObject({ ok: false, code: "RUN_BUDGET" });
    expect((await reserve(40)).ok).toBe(true);
    expect(await reserve(0)).toMatchObject({ ok: false, code: "RUN_BUDGET" });
  });

  it("rejects invalid accounting and latches future calls off after a billing overrun", async () => {
    const { runId } = await harness.start(BRIEF);
    const reserve = (amount: number) =>
      reserveLlmSpend(handle, {
        runId,
        model: "m",
        upperBoundUsd: amount,
        limits: OPEN,
      });
    for (const amount of [-1, NaN, Infinity])
      await expect(reserve(amount)).rejects.toThrow(/Invalid spend/);
    const r = await reserve(0.1);
    if (!r.ok) throw new Error("expected reservation");
    await expect(settleLlmSpend(handle, r.reservationId, -0.1)).rejects.toThrow(
      /Invalid spend/,
    );
    try {
      await settleLlmSpend(handle, r.reservationId, 0.2);
      expect(await reserve(0)).toMatchObject({
        ok: false,
        code: "PAID_RUNS_DISABLED",
      });
    } finally {
      // This database belongs only to this test file; never clear real operator alarms.
      await handle.db.execute(
        sql`DELETE FROM usage_counters WHERE metric = 'llm_billing_overrun'`,
      );
    }
  });

  it("rejects expired and revoked code redemption with the same public response", async () => {
    const s = {
      ...base,
      limiter: new RateLimiter(),
      admission: { ...base.admission, access: "invite" as const },
    };
    const c = await apiClient(s);
    for (const kind of ["expired", "revoked"]) {
      const code = `test-inactive-code-${kind}`;
      const grant = await createDemoGrant(handle.db, {
        label: kind,
        codeHash: hashDemoCode(code, s.pepper),
        expiresAt: new Date(
          Date.now() + (kind === "expired" ? -1 : 1) * 86_400_000,
        ),
        maxRuns: 1,
        maxLlmUsd: 1,
      });
      if (kind === "revoked") await revokeDemoGrant(handle.db, grant.id);
      const response = await postRunAccess(
        s,
        c.post("/api/v1/workspace/access", { code }),
      );
      expect(response.status).toBe(400);
      expect(
        (await json<{ error: { message: string } }>(response)).error.message,
      ).toBe("This access code is not valid or no longer active.");
    }
  });

  it("cannot resume a failed run after access is revoked or capacity is full", async () => {
    const { runId, workspaceId } = await harness.start(BRIEF);
    await handle.db.execute(
      sql`UPDATE agent_runs SET state = 'FAILED', error = '{"transient":true,"failedState":"RESOLVING_ENTITIES"}'::jsonb WHERE id = ${runId}`,
    );
    await expect(
      retryRun(handle, boss, workspaceId, runId, {
        ...base.admission,
        access: "invite",
      }),
    ).rejects.toThrow(/access code/);
    await expect(
      retryRun(handle, boss, workspaceId, runId, {
        ...base.admission,
        maxWorkingGlobal: 0,
      }),
    ).rejects.toThrow(/busy/);
  });

  it("forged IP headers cannot reset access-code attempt limits in direct mode", async () => {
    const s = { ...base, limiter: new RateLimiter(), trustedProxyHops: 0 };
    const c = await apiClient(s);
    for (let n = 0; n < 11; n++) {
      const request = c.post("/api/v1/workspace/access", {
        code: "invalid-test-code",
      });
      request.headers.set("x-forwarded-for", `203.0.113.${n + 1}`);
      const response = await postRunAccess(s, request);
      expect(response.status).toBe(n < 10 ? 400 : 429);
    }
  });
});

describe("Gemini + PostgreSQL spend guard (mock HTTP, synthetic inputs only)", () => {
  it("keeps invite/off protection, persists usage and repairs, and retains reservations on network errors", async () => {
    await freshGlobalDay();
    const { runId, experimentId } = await harness.start(BRIEF);
    const row = await handle.db.execute<{ project_id: string }>(
      sql`SELECT project_id FROM experiments WHERE id = ${experimentId}`,
    );
    const projectId = row.rows[0]!.project_id;
    const model = "gemini-3.5-flash-lite";
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      attempts++;
      if (attempts > 2) throw new Error("private-network-detail");
      return new Response(
        JSON.stringify({
          modelVersion: model,
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: attempts === 1 ? '{"answer":""}' : '{"answer":"ok"}',
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 5,
            totalTokenCount: 115,
          },
        }),
      );
    });
    const provider = new GeminiProvider({
      model,
      apiKey: "test-private-sentinel",
      freeTierConfirmed: true,
      dataSharingApproved: true,
      maxRequests: 3,
      fetch: fetcher,
    });
    const gateway = (access: LlmSpendLimits["access"]) =>
      new LlmGateway({
        provider,
        primaryModel: model,
        spendGuard: createSpendGuard(handle, { ...OPEN, access }),
        recorder: createDbLlmRecorder(handle.db),
      });
    const request = {
      role: "R1" as const,
      promptId: "r1.intent",
      input: { synthetic: true, brief: "Locally invented cafe" },
      schema: z.object({ answer: z.string().min(1) }),
      effort: "low" as const,
      maxOutputTokens: 256,
      ctx: { projectId, runId, inputOrigin: "synthetic" as const },
    };
    for (const access of ["invite", "off"] as const) {
      expect(await gateway(access).generate(request)).toMatchObject({
        ok: false,
        reason: "BUDGET",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(await gateway("open").generate(request)).toMatchObject({
      ok: true,
      attempts: 2,
      costUsd: 0,
      usage: { inputTokens: 160, cachedInputTokens: 40, outputTokens: 30 },
    });
    const recorded = await handle.db.execute(
      sql`SELECT provider, validation_status, output_tokens, estimated_cost_usd FROM llm_invocations WHERE run_id = ${runId} ORDER BY created_at, id`,
    );
    expect(recorded.rows).toMatchObject([
      {
        provider: "gemini",
        validation_status: "INVALID",
        output_tokens: 15,
        estimated_cost_usd: "0.0000",
      },
      {
        provider: "gemini",
        validation_status: "REPAIRED",
        output_tokens: 15,
        estimated_cost_usd: "0.0000",
      },
    ]);
    expect(await counter("run", runId)).toBe(0);
    expect(await gateway("open").generate(request)).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
      attempts: 1,
    });
    const ledger = await handle.db.execute(
      sql`SELECT status FROM llm_spend_reservations WHERE run_id = ${runId} ORDER BY created_at, id`,
    );
    expect(ledger.rows.map((r) => r.status)).toEqual([
      "SETTLED",
      "SETTLED",
      "UNKNOWN",
    ]);
    expect(await counter("run", runId)).toBeGreaterThan(0);
    const failed = await handle.db.execute(
      sql`SELECT stop_reason, validation_errors FROM llm_invocations WHERE run_id = ${runId} AND stop_reason = 'provider_error'`,
    );
    expect(failed.rows).toHaveLength(1);
    expect(JSON.stringify(failed.rows)).toContain("USAGE_UNKNOWN");
    expect(JSON.stringify(failed.rows)).not.toContain("private-network-detail");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("DeepSeek CNY to USD PostgreSQL accounting (mock HTTP only)", () => {
  it("enforces public access, converts once, persists pricing context and retains unknown spend", async () => {
    await freshGlobalDay();
    const { runId, experimentId } = await harness.start(BRIEF);
    const row = await handle.db.execute<{ project_id: string }>(
      sql`SELECT project_id FROM experiments WHERE id = ${experimentId}`,
    );
    const projectId = row.rows[0]!.project_id;
    const now = Date.parse("2026-10-23T10:00:00Z");
    const approval = {
      usdPerCny: 0.2,
      verifiedAt: new Date(now).toISOString(),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "deepseek-v4-pro",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: '{"answer":"ok"}' }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 30,
              total_tokens: 130,
              input_tokens_details: { cached_tokens: 20 },
              output_tokens_details: { reasoning_tokens: 10 },
            },
          }),
        ),
      )
      .mockRejectedValue(new Error("private transport details"));
    const provider = new DeepSeekProvider({
      apiKey: "fake-sentinel",
      liveApproved: true,
      priceApproval: approval,
      maxRequests: 4,
      budgetCny: 2,
      now: () => now,
      fetch: fetcher,
    });
    const gateway = (access: LlmSpendLimits["access"]) =>
      new LlmGateway({
        provider,
        primaryModel: "deepseek-v4-pro",
        prices: deepseekUsdPrices(approval, now),
        pricingContext: {
          billingCurrency: "CNY",
          ledgerCurrency: "USD",
          usdPerCny: 0.2,
        },
        spendGuard: createSpendGuard(handle, { ...OPEN, access }),
        recorder: createDbLlmRecorder(handle.db),
      });
    const request = {
      role: "R1" as const,
      promptId: "r1.intent",
      input: { synthetic: true, brief: "Invented cafe" },
      schema: z.strictObject({ answer: z.string() }),
      effort: "low" as const,
      maxOutputTokens: 8192,
      ctx: { projectId, runId, inputOrigin: "synthetic" as const },
    };
    for (const access of ["off", "invite"] as const)
      expect(await gateway(access).generate(request)).toMatchObject({
        ok: false,
        reason: "BUDGET",
      });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await gateway("open").generate(request);
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      usage: { reasoningTokens: 10 },
    });
    expect(result.costUsd).toBeCloseTo(0.0003072, 10);
    expect(await counter("run", runId)).toBe(308);
    const rows = await handle.db.execute(
      sql`SELECT input_excerpt FROM llm_invocations WHERE run_id = ${runId}`,
    );
    expect(rows.rows[0]!.input_excerpt).toMatchObject({
      billingCurrency: "CNY",
      ledgerCurrency: "USD",
      usdPerCny: 0.2,
      reasoningTokens: 10,
    });
    expect(await gateway("open").generate(request)).toMatchObject({
      ok: false,
      usageComplete: false,
      attempts: 1,
    });
    const ledger = await handle.db.execute(
      sql`SELECT status FROM llm_spend_reservations WHERE run_id = ${runId} ORDER BY created_at,id`,
    );
    expect(ledger.rows.map((r) => r.status)).toEqual(["SETTLED", "UNKNOWN"]);
    expect(await counter("run", runId)).toBeGreaterThan(308);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
