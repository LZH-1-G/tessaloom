import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  postBrief,
  postProject,
  startExperiment,
} from "../../apps/web/src/server/api";
import {
  deleteShareLink,
  getBlueprint,
  getBlueprintExport,
  getShared,
  getSharedExport,
  postBlueprint,
  postBlueprintRevision,
  postShareLink,
} from "../../apps/web/src/server/blueprints";
import { RateLimiter } from "../../apps/web/src/server/http";
import type { Services } from "../../apps/web/src/server/services";
import {
  QUEUES,
  acceptanceReport,
  sql,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { ORIGIN, apiClient, json, makeServices } from "./helpers/api-client";
import { startBoss } from "./helpers/exploration";
import { syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/** M9 API: blueprint endpoints and share-link security (TEST_PLAN §9, SECURITY §4.3). */
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

/** Brief → exploration → selection → composition, all through the API handlers. */
async function composedBlueprint() {
  const c = await apiClient(s);
  const project = await json<{ id: string }>(
    await postProject(
      s,
      c.post("/api/v1/projects", { name: "Share", useCase: "cafe" }),
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
  const ids = { workspaceId: c.workspaceId, ...started };
  await harness.driveToEnd(harness.deps("off"), ids, {
    tension: 0.6,
    select: true,
  });
  const hyp = await handle.db.execute<{ id: string }>(
    sql`SELECT id FROM hypotheses WHERE experiment_id = ${started.experimentId} AND NOT retired ORDER BY composite_score DESC LIMIT 1`,
  );
  const composeRes = await postBlueprint(
    s,
    c.post(`/api/v1/experiments/${started.experimentId}/blueprints`, {
      hypothesisIds: [hyp.rows[0]!.id],
      format: "series",
    }),
    { experimentId: started.experimentId },
  );
  expect(composeRes.status).toBe(202);
  const composed = await json<{ blueprintId: string; runId: string }>(
    composeRes,
  );
  const run = await harness.driveToEnd(
    harness.deps("off"),
    { ...ids, runId: composed.runId },
    { tension: 0.6, select: false },
  );
  expect(run.state).toBe("COMPLETED");
  return {
    c,
    projectId: project.id,
    experimentId: started.experimentId,
    blueprintId: composed.blueprintId,
  };
}

const shareReq = (token: string) =>
  new Request(`${ORIGIN}/api/v1/share/${token}`, {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

describe("M9 blueprint API", () => {
  it("serves the blueprint to its workspace only, with CSRF and concurrency checks", async () => {
    const { c, blueprintId } = await composedBlueprint();
    const res = await getBlueprint(
      s,
      c.get(`/api/v1/blueprints/${blueprintId}`),
      { blueprintId },
    );
    expect(res.status).toBe(200);
    const view = await json<{
      current: { id: string; content: unknown; revisionNumber: number };
    }>(res);
    expect(view.current.revisionNumber).toBe(1);

    const other = await apiClient(s);
    expect(
      (
        await getBlueprint(s, other.get(`/api/v1/blueprints/${blueprintId}`), {
          blueprintId,
        })
      ).status,
    ).toBe(404);
    const path = `/api/v1/blueprints/${blueprintId}/revisions`;
    const body = {
      baseRevisionId: view.current.id,
      content: view.current.content,
    };
    // No CSRF token → 403; another workspace → 404; unchanged content → 400.
    expect(
      (
        await postBlueprintRevision(s, c.post(path, body, false), {
          blueprintId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await postBlueprintRevision(s, other.post(path, body), { blueprintId }))
        .status,
    ).toBe(404);
    expect(
      (await postBlueprintRevision(s, c.post(path, body), { blueprintId }))
        .status,
    ).toBe(400);

    const md = await getBlueprintExport(
      s,
      c.get(`/api/v1/blueprints/${blueprintId}/export?format=md`),
      { blueprintId },
    );
    expect(md.status).toBe(200);
    expect(md.headers.get("content-disposition")).toMatch(
      /attachment; filename=".+-r1\.md"/,
    );
    expect(await md.text()).toContain("## Evidence appendix");
  });
});

describe("M9 share links (SECURITY §4.3, TEST_PLAN §9)", () => {
  it("stores only a peppered hash, serves a scoped read-only payload, and revokes immediately", async () => {
    const { c, projectId, experimentId, blueprintId } =
      await composedBlueprint();
    const created = await postShareLink(
      s,
      c.post(`/api/v1/projects/${projectId}/share-links`, {
        scope: "blueprint",
        targetId: blueprintId,
        expiresInDays: 7,
      }),
      { projectId },
    );
    expect(created.status).toBe(201);
    const { shareLinkId, url } = await json<{
      shareLinkId: string;
      url: string;
    }>(created);
    const token = url.split("/").at(-1)!;
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    const stored = await handle.db.execute<{ token_hash: string }>(
      sql`SELECT token_hash FROM share_links WHERE id = ${shareLinkId}`,
    );
    expect(stored.rows[0]!.token_hash).not.toContain(token);
    expect(stored.rows[0]!.token_hash).toBe(
      createHash("sha256").update(`${token}${s.pepper}`).digest("hex"),
    );

    const res = await getShared(s, shareReq(token), { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const payload = await json<Record<string, unknown>>(res);
    const text = JSON.stringify(payload);
    // Scope: the blueprint only — no workspace, project, experiment, run, or invocation ids.
    expect(payload.scope).toBe("blueprint");
    expect(text).not.toContain(c.workspaceId);
    expect(text).not.toContain(projectId);
    expect(text).not.toContain(experimentId);
    expect(text).not.toMatch(/toolInvocationId|argsRedacted|runId|workspaceId/);
    expect(text).toContain("Evidence");

    // A share token never authorizes mutations: without the workspace cookie they fail.
    const anonymous = new Request(
      `${ORIGIN}/api/v1/blueprints/${blueprintId}/revisions`,
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          host: "tessaloom.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ baseRevisionId: blueprintId, content: {} }),
      },
    );
    expect([401, 403, 404]).toContain(
      (await postBlueprintRevision(s, anonymous, { blueprintId })).status,
    );
    expect((await getSharedExport(s, shareReq(token), { token })).status).toBe(
      200,
    );
    // Public exports carry no internal identifiers, like the shared page.
    for (const format of ["json", "md"]) {
      const exported = await getSharedExport(
        s,
        new Request(`${ORIGIN}/api/v1/share/${token}/export?format=${format}`, {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
        { token },
      );
      expect(exported.status).toBe(200);
      const body = await exported.text();
      expect(body).toContain("E-1");
      expect(body).not.toContain(blueprintId);
      expect(body).not.toMatch(/"toolInvocationId":\s*"/);
      const ids = await handle.db.execute<{ id: string }>(
        sql`SELECT tool_invocation_id AS id FROM evidence_records WHERE tool_invocation_id IS NOT NULL LIMIT 20`,
      );
      for (const { id } of ids.rows) expect(body).not.toContain(id);
    }

    // A target outside the project is refused.
    const other = await composedBlueprint();
    expect(
      (
        await postShareLink(
          s,
          c.post(`/api/v1/projects/${projectId}/share-links`, {
            scope: "blueprint",
            targetId: other.blueprintId,
          }),
          { projectId },
        )
      ).status,
    ).toBe(404);

    // Revocation is immediate, and the answer does not reveal whether anything exists.
    expect(
      (
        await deleteShareLink(
          s,
          c.post(`/api/v1/share-links/${shareLinkId}`, {}),
          { shareLinkId },
        )
      ).status,
    ).toBe(204);
    const revoked = await getShared(s, shareReq(token), { token });
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toContain("This link is no longer active.");
    expect((await getSharedExport(s, shareReq(token), { token })).status).toBe(
      404,
    );
    const bogus = "A".repeat(43);
    const unknown = await getShared(s, shareReq(bogus), { token: bogus });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("This link is no longer active.");
  });

  it("serves project shares as a read-only story without ids or raw Qloo values", async () => {
    const { c, projectId, experimentId, blueprintId } =
      await composedBlueprint();
    const created = await postShareLink(
      s,
      c.post(`/api/v1/projects/${projectId}/share-links`, {
        scope: "project",
        targetId: projectId,
        expiresInDays: 30,
      }),
      { projectId },
    );
    expect(created.status).toBe(201);
    const token = (await json<{ url: string }>(created)).url.split("/").at(-1)!;
    const payload = await json<{
      story: {
        fixture: boolean;
        brief: { title: string; interests: string[] } | null;
        seeds: { name: string; domain: string }[];
        discovery: { threadResults: number; bridges: unknown[][] };
        hypotheses: {
          carriedToBlueprint: boolean;
          claims: { evidence: { provenanceClass: string } | null }[];
        }[];
        blueprint: { revision: unknown } | null;
      };
    }>(await getShared(s, shareReq(token), { token }));
    const { story } = payload;
    expect(story.brief?.interests.length).toBeGreaterThanOrEqual(2);
    expect(story.seeds.length).toBeGreaterThanOrEqual(2);
    expect(story.discovery.threadResults).toBeGreaterThan(0);
    expect(story.discovery.bridges.length).toBeGreaterThan(0);
    expect(story.hypotheses[0]!.carriedToBlueprint).toBe(true);
    expect(
      story.hypotheses.flatMap((h) => h.claims).some((cl) => cl.evidence),
    ).toBe(true);
    expect(story.blueprint?.revision).toBeTruthy();
    // Fixture-derived content keeps its marker for the banner and the production firewall.
    expect(JSON.stringify(story)).toContain("DEVELOPMENT_FIXTURE");
    expect(story.fixture).toBe(true);

    const text = JSON.stringify(payload);
    for (const id of [c.workspaceId, projectId, experimentId, blueprintId])
      expect(text).not.toContain(id);
    // No identifier, raw Qloo value or usage field appears as a key anywhere in the payload.
    expect(text).not.toMatch(
      /"(toolInvocationId|runId|workspaceId|projectId|experimentId|qlooId|snapshot|popularity|affinity|disambiguation|localityText|notes|costUsd|inputTokens|outputTokens)":/,
    );
  });

  it("a full workflow needs two run admissions: composition counts against the daily allowance", async () => {
    const c = await apiClient(s);
    const project = await json<{ id: string }>(
      await postProject(
        s,
        c.post("/api/v1/projects", { name: "Allowance", useCase: "cafe" }),
      ),
    );
    const brief = await json<{ id: string }>(
      await postBrief(
        s,
        c.post(`/api/v1/projects/${project.id}/briefs`, {
          title: "Allowance check",
          challenge: "A 40-seat café wants a monthly night for two fan groups.",
          interests: [
            { text: "Stardew Harvest Tales", domainHint: "videogame" },
            { text: "Paper Atlas Stories", domainHint: "book" },
          ],
          venue: { type: "cafe", capacity: 40 },
          goals: ["Attract new weekday visitors"],
        }),
        { projectId: project.id },
      ),
    );
    // Production run limits: one active run per workspace, N runs per workspace per day.
    const production = (dailyRunsPerWorkspace: number): Services => ({
      ...s,
      limiter: new RateLimiter(),
      admission: {
        ...s.admission,
        maxActivePerWorkspace: 1,
        maxWorkingGlobal: 1,
        dailyRunsPerWorkspace,
      },
    });
    const started = await json<{ experimentId: string; runId: string }>(
      await startExperiment(
        production(1),
        c.post(`/api/v1/projects/${project.id}/experiments`, {
          briefVersionId: brief.id,
          mode: "live",
        }),
        { projectId: project.id },
      ),
    );
    await harness.driveToEnd(
      harness.deps("off"),
      { workspaceId: c.workspaceId, ...started },
      { tension: 0.6, select: true },
    );
    const hyp = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM hypotheses WHERE experiment_id = ${started.experimentId} AND NOT retired ORDER BY composite_score DESC LIMIT 1`,
    );
    const compose = (svc: Services) =>
      postBlueprint(
        svc,
        c.post(`/api/v1/experiments/${started.experimentId}/blueprints`, {
          hypothesisIds: [hyp.rows[0]!.id],
          format: "series",
        }),
        { experimentId: started.experimentId },
      );
    // WORKSPACE_DAILY_RUNS=1 admits the exploration but refuses the blueprint.
    const refused = await compose(production(1));
    expect(refused.status).toBe(429);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
      "RUN_LIMIT",
    );
    // Two daily runs let the same journey finish; the paused exploration does not block it.
    expect((await compose(production(2))).status).toBe(202);
  });

  it("reports acceptance evidence as metadata only", async () => {
    const { c, projectId } = await composedBlueprint();
    const report = (await acceptanceReport(handle.db, projectId))!;
    expect(report.runs.map((r) => r.state)).toContain("COMPLETED");
    expect(report.llmCalls.length).toBeGreaterThan(0);
    expect(report.llmCalls[0]).toHaveProperty("outputTokens");
    expect(report.qlooCalls.length).toBeGreaterThan(0);
    expect(report.ledger).toHaveProperty("settledUsd");
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(report.blueprints[0]).toHaveProperty("traceability");
    const text = JSON.stringify(report);
    expect(text).not.toContain(c.workspaceId);
    expect(text).not.toMatch(
      /"(input_excerpt|inputExcerpt|output|content|premise|argsRedacted|args_redacted|tokenHash)":/,
    );
    expect(await acceptanceReport(handle.db, c.workspaceId)).toBeNull();
  });

  it("expires links, scopes experiment links, and rate-limits lookups", async () => {
    const { c, projectId, experimentId } = await composedBlueprint();
    const created = await json<{ shareLinkId: string; url: string }>(
      await postShareLink(
        s,
        c.post(`/api/v1/projects/${projectId}/share-links`, {
          scope: "experiment",
          targetId: experimentId,
        }),
        { projectId },
      ),
    );
    const token = created.url.split("/").at(-1)!;
    const view = await json<{
      scope: string;
      experiment: { hypotheses: unknown[] };
    }>(await getShared(s, shareReq(token), { token }));
    expect(view.scope).toBe("experiment");
    expect(view.experiment.hypotheses.length).toBeGreaterThan(0);
    // A blueprint-only export is refused for an experiment link.
    expect((await getSharedExport(s, shareReq(token), { token })).status).toBe(
      404,
    );

    await handle.db.execute(
      sql`UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = ${created.shareLinkId}`,
    );
    expect((await getShared(s, shareReq(token), { token })).status).toBe(404);

    // 30 lookups per minute per IP hash; the 31st is refused.
    const limited: Services = { ...s, limiter: new RateLimiter() };
    for (let i = 0; i < 30; i++)
      await getShared(limited, shareReq("B".repeat(43)), {
        token: "B".repeat(43),
      });
    expect(
      (
        await getShared(limited, shareReq("B".repeat(43)), {
          token: "B".repeat(43),
        })
      ).status,
    ).toBe(429);
  });
});
