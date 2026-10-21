import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getExperiment,
  getWorkspace,
  postBrief,
  postConfirmation,
  postProject,
  startExperiment,
} from "../../apps/web/src/server/api";
import { RateLimiter } from "../../apps/web/src/server/http";
import type { Services } from "../../apps/web/src/server/services";
import {
  buildPorts,
  buildRunConfig,
  createQlooAdapter,
} from "../../apps/worker/src/compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
} from "../../apps/worker/src/llm";
import type { RunnerDeps } from "../../apps/worker/src/orchestrator/runner";
import {
  beatWorker,
  getRun,
  QUEUES,
  sql,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { PromptRegistry } from "../../packages/llm-gateway/src";
import { SyntheticFixtureTransport } from "../../packages/qloo-adapter/src";
import { drain, startBoss } from "./helpers/exploration";
import { createTestDatabase } from "./helpers/test-db";

let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let s: Services;
const ORIGIN = "http://tessaloom.test";

const RUN_CONFIG = buildRunConfig({
  llmModel: "scripted-demo",
  llmFallbackModel: "scripted-demo-fallback",
  promptVersions: new PromptRegistry().versions(),
  harnessVersion: "synthetic",
});

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  s = {
    handle,
    boss: async () => boss,
    sessionSecret: "discovery-session-secret-32-bytes-long!",
    appEnv: "test",
    pepper: "discovery-pepper-value-32-bytes-long!!",
    secureCookies: false,
    limiter: new RateLimiter(),
    now: () => new Date(),
    heartbeatMaxAgeMs: 30_000,
    sse: { pollMs: 10, pingMs: 30, maxDurationMs: 5_000 },
    dailyRunsPerWorkspace: 10,
  };
  await beatWorker(handle.db, {
    workerId: "discovery-worker",
    qlooReady: true,
    harnessVersion: "synthetic",
    transport: "synthetic",
    runConfig: RUN_CONFIG,
  });
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

async function client() {
  const res = await getWorkspace(s, new Request(`${ORIGIN}/api/v1/workspace`));
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const csrf = cookies.find((c) => c.startsWith("tl_csrf="))!.slice(8);
  const headers = {
    cookie: cookies.join("; "),
    origin: ORIGIN,
    host: "tessaloom.test",
    "x-tessaloom-csrf": csrf,
    "content-type": "application/json",
  };
  return {
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      }),
    get: (path: string) => new Request(`${ORIGIN}${path}`, { headers }),
  };
}

function deps(transport: SyntheticFixtureTransport): RunnerDeps {
  const qloo = createQlooAdapter(handle.db, {
    mode: "synthetic",
    appEnv: "test",
    harnessVersion: "synthetic",
    dailyLimit: 1000,
    rateLimitPerMin: 100_000,
    transport,
  });
  const llm = createLlmGateway(
    {
      LLM_PROVIDER: "scripted",
      LLM_MODEL: "claude-opus-5-5",
      LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
      LLM_MODE: "standard",
    },
    createDbLlmRecorder(handle.db),
  );
  return { handle, boss, ports: buildPorts(qloo, llm), cancelPollMs: 50 };
}

const json = async <T>(res: Response) => (await res.json()) as T;

describe("M5: brief → H1 (with an edit) → H2 (tag + locality) → discovery on the V1 contract", () => {
  it("resolves with exact-single only, records every Qloo call, and builds threads and tags", async () => {
    const c = await client();
    const transport = new SyntheticFixtureTransport("test");
    const d = deps(transport);
    const project = await json<{ id: string }>(
      await postProject(
        s,
        c.post("/api/v1/projects", { name: "Low-Fi Lounge", useCase: "cafe" }),
      ),
    );
    const briefRes = await postBrief(
      s,
      c.post(`/api/v1/projects/${project.id}/briefs`, {
        title: "Low-Fi Lounge weeknights",
        challenge:
          "A 35-seat cafe wants a recurring weekday evening for a creative crowd.",
        interests: [
          { text: "cumbia" },
          { text: "Stardew Harvest Tales", domainHint: "videogame" },
          { text: "Paper Atlas Stories" },
        ],
        venue: { type: "cafe", localityText: "Lisbon", capacity: 35 },
        constraints: { budgetBand: "low", durationMinutes: 120 },
        goals: ["Attract new weekday visitors"],
      }),
      { projectId: project.id },
    );
    expect(briefRes.status).toBe(201);
    const brief = await json<{ id: string }>(briefRes);
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
    await drain(d);
    expect((await getRun(handle.db, started.runId)).state).toBe(
      "AWAITING_BRIEF_CONFIRMATION",
    );

    // H1: the user types interest 2 as a book (USER_PROVIDED hint), overriding the guess.
    const h1 = await postConfirmation(
      s,
      c.post(`/api/v1/runs/${started.runId}/confirmations`, {
        kind: "BRIEF",
        briefVersionId: brief.id,
        action: "confirm",
        interestDomains: [{ interestIndex: 2, domain: "book" }],
      }),
      { runId: started.runId },
    );
    expect(h1.status).toBe(202);
    await drain(d);
    let run = await getRun(handle.db, started.runId);
    expect(run.state).toBe("AWAITING_ENTITY_CONFIRMATION");
    // "cumbia" (untyped) and the locality need a choice; the typed multi-word titles were exact.
    expect(run.pendingConfirmation).toEqual({
      kind: "ENTITIES",
      interestIndexes: [0, 3],
    });

    const view = await json<{
      resolutions: {
        interestIndex: number;
        status: string;
        method: string | null;
        domainHint: string | null;
        requestedKind: string;
        candidates: {
          entities: {
            qlooId: string;
            disambiguation?: string;
            type?: string;
          }[];
          tags: { tagId: string; name: string }[];
        };
      }[];
    }>(
      await getExperiment(
        s,
        c.get(`/api/v1/experiments/${started.experimentId}`),
        { experimentId: started.experimentId },
      ),
    );
    const byIndex = new Map(view.resolutions.map((r) => [r.interestIndex, r]));
    expect(byIndex.get(1)).toMatchObject({
      status: "RESOLVED",
      method: "EXACT_SINGLE",
    });
    expect(byIndex.get(2)).toMatchObject({
      status: "RESOLVED",
      method: "EXACT_SINGLE",
      domainHint: "book",
    });
    const cumbia = byIndex.get(0)!;
    expect(cumbia.status).toBe("AMBIGUOUS");
    expect(cumbia.candidates.tags.length).toBeGreaterThan(0); // find_tags for untyped interests
    expect(cumbia.candidates.entities.length).toBeGreaterThan(1);
    const locality = byIndex.get(3)!;
    expect(locality).toMatchObject({
      requestedKind: "locality",
      status: "AMBIGUOUS",
    });
    // V1: api search supplies the disambiguation strings describe omits.
    expect(locality.candidates.entities.every((e) => !!e.disambiguation)).toBe(
      true,
    );

    const h2 = await postConfirmation(
      s,
      c.post(`/api/v1/runs/${started.runId}/confirmations`, {
        kind: "ENTITIES",
        selections: [
          {
            interestIndex: 0,
            choice: {
              type: "candidate",
              qlooId: cumbia.candidates.tags[0]!.tagId,
            },
          },
          {
            interestIndex: 3,
            choice: {
              type: "candidate",
              qlooId: locality.candidates.entities[0]!.qlooId,
            },
          },
        ],
      }),
      { runId: started.runId },
    );
    expect(h2.status).toBe(202);
    await drain(d, 4); // discovery and a few loop steps
    run = await getRun(handle.db, started.runId);

    const seeds = await handle.db.execute<{
      role: string;
      kind: string;
      domain: string | null;
    }>(
      sql`SELECT s.role, e.kind, e.domain FROM experiment_seeds s JOIN cultural_entities e ON e.id = s.entity_id WHERE s.experiment_id = ${started.experimentId} ORDER BY s.ordinal`,
    );
    expect(seeds.rows).toEqual([
      { role: "seed", kind: "tag", domain: "tag" },
      { role: "seed", kind: "entity", domain: "videogame" },
      { role: "seed", kind: "entity", domain: "book" },
      { role: "location", kind: "locality", domain: "locality" },
    ]);
    const rel = await handle.db.execute<{ kind: string; n: string }>(
      sql`SELECT kind, count(*)::text AS n FROM entity_relations WHERE experiment_id = ${started.experimentId} GROUP BY kind ORDER BY kind`,
    );
    const counts = Object.fromEntries(
      rel.rows.map((r) => [r.kind, Number(r.n)]),
    );
    expect(counts.THREAD).toBeGreaterThan(50);
    expect(counts.HAS_TAG).toBeGreaterThan(0);

    // CI-A2: every Qloo transport call has a tool_invocations row (cache hits add CACHE rows).
    const inv = await handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM tool_invocations WHERE run_id = ${started.runId} AND data_origin <> 'CACHE'`,
    );
    expect(Number(inv.rows[0]!.n)).toBe(transport.calls);
    // CI-A3 (ingest side): every relation fact was verified against the response before discard.
    const facts = await handle.db.execute<{ verified: boolean }>(
      sql`SELECT (f->>'verifiedAtIngest')::boolean AS verified FROM entity_relations r, jsonb_array_elements(r.facts) f WHERE r.experiment_id = ${started.experimentId}`,
    );
    expect(facts.rows.length).toBeGreaterThan(0);
    expect(facts.rows.every((f) => f.verified)).toBe(true);
    // Fixture firewall: synthetic data is labeled DEVELOPMENT_FIXTURE end to end.
    const provenance = await handle.db.execute<{ p: string }>(
      sql`SELECT DISTINCT r.provenance_class AS p FROM entity_relations r WHERE r.experiment_id = ${started.experimentId}`,
    );
    expect(provenance.rows.map((r) => r.p)).toEqual(["DEVELOPMENT_FIXTURE"]);
    expect(["FAILED", "CANCELLED"]).not.toContain(run.state);
  });
});

describe("fixture firewall through the cache (migration 0003)", () => {
  it("rejects Qloo-sourced records whose CACHE invocation was served from a FIXTURE one", async () => {
    const {
      createProject,
      createWorkspace,
      recordToolInvocation,
      upsertCulturalEntity,
    } = await import("../../packages/db/src");
    const ws = await createWorkspace(handle.db, { secretHash: "f".repeat(64) });
    const project = await createProject(handle.db, {
      workspaceId: ws.id,
      name: "Firewall",
      useCase: "cafe",
    });
    const base = {
      projectId: project.id,
      purpose: "test",
      method: "recommend",
      workflow: "recommend",
      transport: "FIXTURE" as const,
      argsRedacted: {},
      requestHash: "c".repeat(64),
      summary: {
        status: "ok" as const,
        shape: "result_list" as const,
        resultCount: 1,
        errorCode: null,
        retryable: null,
      },
    };
    const fixture = await recordToolInvocation(handle.db, {
      ...base,
      dataOrigin: "FIXTURE",
    });
    const cached = await recordToolInvocation(handle.db, {
      ...base,
      dataOrigin: "CACHE",
      cacheSourceInvocationId: fixture.id,
    });
    const entity = {
      workspaceId: ws.id,
      kind: "entity" as const,
      name: "Cached fixture",
      snapshot: {},
      sourceToolInvocationId: cached.id,
    };
    await expect(
      upsertCulturalEntity(handle.db, {
        ...entity,
        qlooId: "FX-1",
        provenanceClass: "QLOO_SOURCED",
      }),
    ).rejects.toThrow();
    const ok = await upsertCulturalEntity(handle.db, {
      ...entity,
      qlooId: "FX-2",
      provenanceClass: "DEVELOPMENT_FIXTURE",
    });
    expect(ok.provenanceClass).toBe("DEVELOPMENT_FIXTURE");
  });
});
