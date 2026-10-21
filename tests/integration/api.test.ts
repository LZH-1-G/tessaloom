import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getRun as getRunApi,
  getWorkspace,
  postCancel,
  postConfirmation,
  postRetry,
  startExperiment,
  streamEvents,
} from "../../apps/web/src/server/api";
import { RateLimiter } from "../../apps/web/src/server/http";
import { uuidv7 } from "../../packages/core/src";
import type { Services } from "../../apps/web/src/server/services";
import { runStep } from "../../apps/worker/src/orchestrator/runner";
import {
  QUEUES,
  beatWorker,
  createBriefVersion,
  createProject,
  getRun,
  sql,
  withTx,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import {
  ProviderError,
  ScriptedLlmProvider,
} from "../../packages/llm-gateway/src";
import {
  BRIEF,
  FixtureLibrary,
  INTENT_OUTPUT,
  RUN_CONFIG,
  drain,
  makeDeps,
  scriptedExplorationLlm,
  standardFixtures,
  startBoss,
} from "./helpers/exploration";
import { createTestDatabase } from "./helpers/test-db";

let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let lib: FixtureLibrary;
let s: Services;

const ORIGIN = "http://tessaloom.test";

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  lib = await FixtureLibrary.create();
  await standardFixtures(lib);
  s = {
    handle,
    boss: async () => boss,
    sessionSecret: "test-session-secret-at-least-32-bytes!!",
    appEnv: "test",
    pepper: "test-pepper-at-least-32-bytes-long!!!!",
    secureCookies: false,
    limiter: new RateLimiter(),
    now: () => new Date(),
    heartbeatMaxAgeMs: 30_000,
    sse: { pollMs: 10, pingMs: 30, maxDurationMs: 5_000 },
    dailyRunsPerWorkspace: 10,
  };
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
  await lib?.remove();
});

/** A browser-like client: keeps cookies, echoes the CSRF token, sends Origin. */
async function client(services: Services = s) {
  const res = await getWorkspace(
    services,
    new Request(`${ORIGIN}/api/v1/workspace`),
  );
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const set = res.headers.getSetCookie().join("\n");
  expect(set).toMatch(
    /tl_ws=[^;]+; Path=\/; SameSite=Lax; Max-Age=31536000; HttpOnly/,
  );
  const csrf = cookies
    .find((c) => c.startsWith("tl_csrf="))!
    .slice("tl_csrf=".length);
  const workspace = (await res.json()) as { id: string };
  const headers = (extra: Record<string, string> = {}) => ({
    cookie: cookies.join("; "),
    origin: ORIGIN,
    host: "tessaloom.test",
    "x-tessaloom-csrf": csrf,
    "content-type": "application/json",
    ...extra,
  });
  const post = (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: headers(extra),
      body: JSON.stringify(body),
    });
  const get = (path: string, extra: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { headers: headers(extra) });
  return { workspace, headers, post, get };
}

async function projectFor(workspaceId: string) {
  const project = await createProject(handle.db, {
    workspaceId,
    name: "API",
    useCase: "cafe",
  });
  const brief = await withTx(handle.db, (tx) =>
    createBriefVersion(tx, { projectId: project.id, content: BRIEF }),
  );
  return { project, brief };
}

const beat = (ageMs = 0) =>
  beatWorker(handle.db, {
    workerId: "api-test-worker",
    qlooReady: true,
    harnessVersion: "fixture",
    transport: "fixture",
    runConfig: RUN_CONFIG,
  }).then(() =>
    handle.db.execute(
      sql`UPDATE worker_heartbeats SET last_beat_at = now() - make_interval(secs => ${ageMs / 1000}) WHERE worker_id = 'api-test-worker'`,
    ),
  );

type Body = Record<string, unknown> & { error?: { code: string } };
const body = async (res: Response) => (await res.json()) as Body;

/** Read an SSE response to completion (the server closes it on a paused/terminal state). */
async function readSse(res: Response) {
  const text = await res.text();
  const events: { id: number; data: { seq: number; type: string } }[] = [];
  let terminal: Record<string, unknown> | null = null;
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const id = lines.find((l) => l.startsWith("id: "));
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (event === "run-event" && id && data)
      events.push({ id: Number(id.slice(4)), data: JSON.parse(data) });
    if (event === "run-terminal" && data) terminal = JSON.parse(data);
  }
  return { events, terminal, text };
}

describe("workspace, CSRF, and authorization", () => {
  it("requires a workspace cookie, a CSRF token, and a matching Origin for mutations", async () => {
    const c = await client();
    const { project, brief } = await projectFor(c.workspace.id);
    const path = `/api/v1/projects/${project.id}/experiments`;
    const payload = { briefVersionId: brief.id, mode: "live" };
    const noCookie = new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { ...c.headers(), cookie: "" },
      body: JSON.stringify(payload),
    });
    expect(
      (
        await body(
          await startExperiment(s, noCookie, { projectId: project.id }),
        )
      ).error?.code,
    ).toBe("CSRF_FAILED");
    const noCsrf = c.post(path, payload, { "x-tessaloom-csrf": "wrong" });
    expect(
      (await startExperiment(s, noCsrf, { projectId: project.id })).status,
    ).toBe(403);
    const badOrigin = c.post(path, payload, { origin: "https://evil.example" });
    expect(
      (
        await body(
          await startExperiment(s, badOrigin, { projectId: project.id }),
        )
      ).error?.code,
    ).toBe("CSRF_FAILED");
    const noWorkspace = c.post(path, payload, {
      cookie: c.headers().cookie.replace(/tl_ws=[^;]+/, "tl_ws=forged"),
    });
    expect(
      (
        await body(
          await startExperiment(s, noWorkspace, { projectId: project.id }),
        )
      ).error?.code,
    ).toBe("WORKSPACE_REQUIRED");
  });

  it("hides other workspaces' projects and runs (404) and reports an offline worker (503)", async () => {
    const owner = await client();
    const stranger = await client();
    const { project, brief } = await projectFor(owner.workspace.id);
    await handle.db.execute(sql`DELETE FROM worker_heartbeats`);
    const path = `/api/v1/projects/${project.id}/experiments`;
    const offline = await startExperiment(
      s,
      owner.post(path, { briefVersionId: brief.id, mode: "live" }),
      { projectId: project.id },
    );
    expect(offline.status).toBe(503);
    expect((await body(offline)).error?.code).toBe("WORKER_OFFLINE");
    await beat(31_000); // stale
    expect(
      (
        await startExperiment(
          s,
          owner.post(path, { briefVersionId: brief.id, mode: "live" }),
          { projectId: project.id },
        )
      ).status,
    ).toBe(503);
    await beat();
    const started = await body(
      await startExperiment(
        s,
        owner.post(path, { briefVersionId: brief.id, mode: "live" }),
        { projectId: project.id },
      ),
    );
    const foreign = await startExperiment(
      s,
      stranger.post(path, { briefVersionId: brief.id, mode: "live" }),
      { projectId: project.id },
    );
    expect(foreign.status).toBe(404);
    const runPath = `/api/v1/runs/${started.runId as string}`;
    expect(
      (
        await getRunApi(s, stranger.get(runPath), {
          runId: started.runId as string,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await streamEvents(s, stranger.get(`${runPath}/events`), {
          runId: started.runId as string,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await postCancel(s, stranger.post(`${runPath}/cancel`, {}), {
          runId: started.runId as string,
        })
      ).status,
    ).toBe(404);
  });
});

describe("starting experiments", () => {
  it("returns 202, honors Idempotency-Key, rejects key reuse with another body, and reuses the experiment key", async () => {
    await beat();
    const c = await client();
    const { project, brief } = await projectFor(c.workspace.id);
    const path = `/api/v1/projects/${project.id}/experiments`;
    const idempotencyHeader = uuidv7();
    const first = await startExperiment(
      s,
      c.post(
        path,
        { briefVersionId: brief.id, mode: "live" },
        { "idempotency-key": idempotencyHeader },
      ),
      { projectId: project.id },
    );
    expect(first.status).toBe(202);
    const a = await body(first);
    expect(a).toMatchObject({
      reused: false,
      experimentKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const again = await body(
      await startExperiment(
        s,
        c.post(
          path,
          { briefVersionId: brief.id, mode: "live" },
          { "idempotency-key": idempotencyHeader },
        ),
        { projectId: project.id },
      ),
    );
    expect(again).toEqual(a);
    const mismatch = await startExperiment(
      s,
      c.post(
        path,
        {
          briefVersionId: brief.id,
          mode: "live",
          variables: { collisionTension: 0.8 },
        },
        { "idempotency-key": idempotencyHeader },
      ),
      { projectId: project.id },
    );
    expect(mismatch.status).toBe(409);
    expect((await body(mismatch)).error?.code).toBe("IDEMPOTENCY_MISMATCH");
    const reused = await body(
      await startExperiment(
        s,
        c.post(path, { briefVersionId: brief.id, mode: "live" }),
        { projectId: project.id },
      ),
    );
    expect(reused).toMatchObject({
      reused: true,
      runId: a.runId,
      experimentId: a.experimentId,
    });
    const invalid = await startExperiment(
      s,
      c.post(path, { briefVersionId: "nope", mode: "live" }),
      { projectId: project.id },
    );
    expect(invalid.status).toBe(400);
    expect((await body(invalid)).error?.code).toBe("VALIDATION_FAILED");
    // Fixture mode is taken from the worker, never from the client.
    const mode = await handle.db.execute<{ mode: string }>(
      sql`SELECT mode FROM experiments WHERE id = ${a.experimentId as string}`,
    );
    expect(mode.rows[0]!.mode).toBe("fixture");
  });

  it("rate-limits run starts per workspace with Retry-After", async () => {
    await beat();
    const limited: Services = { ...s, limiter: new RateLimiter() };
    const c = await client(limited);
    const { project, brief } = await projectFor(c.workspace.id);
    const path = `/api/v1/projects/${project.id}/experiments`;
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 7; i++) {
      last = await startExperiment(
        limited,
        c.post(path, { briefVersionId: brief.id, mode: "live" }),
        { projectId: project.id },
      );
      statuses.push(last.status);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 429]);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await body(last!)).error?.code).toBe("RATE_LIMITED");
  });
});

describe("human gates, cancellation, retry, and SSE", () => {
  async function startedRun(provider = scriptedExplorationLlm()) {
    await beat();
    const c = await client();
    const { project, brief } = await projectFor(c.workspace.id);
    const res = await body(
      await startExperiment(
        s,
        c.post(`/api/v1/projects/${project.id}/experiments`, {
          briefVersionId: brief.id,
          mode: "live",
        }),
        { projectId: project.id },
      ),
    );
    return {
      c,
      brief,
      runId: res.runId as string,
      deps: makeDeps(handle, boss, lib, provider),
    };
  }

  it("rejects a confirmation of the wrong kind or for a non-paused run with 409 (TEST_PLAN §4 item 11)", async () => {
    const { c, brief, runId, deps } = await startedRun();
    const path = `/api/v1/runs/${runId}/confirmations`;
    const notPaused = await postConfirmation(
      s,
      c.post(path, {
        kind: "BRIEF",
        briefVersionId: brief.id,
        action: "confirm",
      }),
      { runId },
    );
    expect(notPaused.status).toBe(409);
    expect((await body(notPaused)).error?.code).toBe("STATE_CONFLICT");
    await drain(deps);
    const wrongKind = await postConfirmation(
      s,
      c.post(path, { kind: "HYPOTHESIS_SELECTION", selectedHypothesisIds: [] }),
      { runId },
    );
    expect(wrongKind.status).toBe(409);
    const malformed = await postConfirmation(
      s,
      c.post(path, { kind: "BRIEF" }),
      { runId },
    );
    expect(malformed.status).toBe(400);
    // Two confirmations at the same time: exactly one wins (TEST_PLAN §8).
    const both = await Promise.all([
      postConfirmation(
        s,
        c.post(path, {
          kind: "BRIEF",
          briefVersionId: brief.id,
          action: "confirm",
        }),
        { runId },
      ),
      postConfirmation(
        s,
        c.post(path, {
          kind: "BRIEF",
          briefVersionId: brief.id,
          action: "confirm",
        }),
        { runId },
      ),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    const view = await body(both.find((r) => r.status === 202)!);
    expect(view).toMatchObject({
      state: "RESOLVING_ENTITIES",
      pendingConfirmation: null,
    });
  });

  it("streams events with resume from Last-Event-ID: no duplicates and no gaps across reconnects", async () => {
    const { c, brief, runId, deps } = await startedRun();
    const eventsPath = `/api/v1/runs/${runId}/events`;
    await drain(deps); // → AWAITING_BRIEF_CONFIRMATION
    const first = await readSse(
      await streamEvents(s, c.get(eventsPath), { runId }),
    );
    expect(first.terminal).toMatchObject({
      state: "AWAITING_BRIEF_CONFIRMATION",
    });
    expect(first.events.map((e) => e.id)).toEqual(
      first.events.map((_, i) => i + 1),
    );
    expect(first.events.at(-1)!.data.type).toBe("CONFIRMATION_REQUESTED");
    expect(first.text).not.toMatch(/untrusted_input|SECRET|sk-ant/);

    // A dropped connection resumes after the last received id.
    const cut = first.events[2]!.id;
    const resumed = await readSse(
      await streamEvents(
        s,
        c.get(eventsPath, { "last-event-id": String(cut) }),
        { runId },
      ),
    );
    expect(resumed.events.map((e) => e.id)).toEqual(
      first.events.filter((e) => e.id > cut).map((e) => e.id),
    );
    // ?after= works for clients without Last-Event-ID support.
    const viaQuery = await readSse(
      await streamEvents(s, c.get(`${eventsPath}?after=${cut}`), { runId }),
    );
    expect(viaQuery.events.map((e) => e.id)).toEqual(
      resumed.events.map((e) => e.id),
    );

    // Live streaming while the worker progresses: confirm, then run steps while connected.
    await postConfirmation(
      s,
      c.post(`/api/v1/runs/${runId}/confirmations`, {
        kind: "BRIEF",
        briefVersionId: brief.id,
        action: "confirm",
      }),
      { runId },
    );
    const lastSeen = first.events.at(-1)!.id;
    const live = streamEvents(
      s,
      c.get(eventsPath, { "last-event-id": String(lastSeen) }),
      { runId },
    );
    const [response] = await Promise.all([live, drain(deps)]);
    const second = await readSse(response);
    expect(second.terminal).toMatchObject({
      state: "AWAITING_ENTITY_CONFIRMATION",
    });
    const ids = second.events.map((e) => e.id);
    expect(ids[0]).toBe(lastSeen + 1);
    expect(ids).toEqual(ids.map((_, i) => lastSeen + 1 + i));
    const all = await handle.db.execute<{ n: string }>(
      sql`SELECT max(seq) AS n FROM run_events WHERE run_id = ${runId}`,
    );
    expect(ids.at(-1)).toBe(Number(all.rows[0]!.n));
  });

  it("cancels a paused run immediately and idempotently", async () => {
    const { c, runId, deps } = await startedRun();
    await drain(deps);
    const res = await postCancel(
      s,
      c.post(`/api/v1/runs/${runId}/cancel`, {}),
      { runId },
    );
    expect(res.status).toBe(202);
    expect(await body(res)).toMatchObject({
      state: "CANCELLED",
      cancelRequested: true,
      terminalReason: "USER_CANCELLED",
    });
    const again = await body(
      await postCancel(s, c.post(`/api/v1/runs/${runId}/cancel`, {}), {
        runId,
      }),
    );
    expect(again).toMatchObject({ state: "CANCELLED" });
    const types = (
      await handle.db.execute<{ type: string }>(
        sql`SELECT type FROM run_events WHERE run_id = ${runId} ORDER BY seq`,
      )
    ).rows.map((r) => r.type);
    expect(types.filter((t) => t === "CANCEL_REQUESTED")).toHaveLength(1);
    expect(types.at(-1)).toBe("RUN_CANCELLED");
    expect(await drain(deps)).toEqual([]);
  });

  it("retries a transient LLM failure from FAILED, and refuses to retry a permanent one", async () => {
    // The provider is down for the whole first step (primary and fallback).
    const down = {
      error: new ProviderError(
        "unavailable",
        "LLM unavailable (529)",
        true,
        529,
      ),
    };
    const provider = new ScriptedLlmProvider().on(
      "r1.intent",
      down,
      down,
      down,
      down,
    );
    const { c, runId, deps } = await startedRun(provider);
    await drain(deps, 1); // QUEUED → ANALYZING_INTENT
    let run = await getRun(handle.db, runId);
    expect(run.state).toBe("ANALYZING_INTENT");
    const job = { runId, expectedStateVersion: run.stateVersion };
    // Retries remain: the step asks pg-boss to retry (no commit).
    await expect(
      runStep(deps, job, { retryCount: 0, retryLimit: 2 }),
    ).rejects.toThrow();
    expect((await getRun(handle.db, runId)).stateVersion).toBe(
      run.stateVersion,
    );
    // Last attempt: the run fails with a transient, retryable error.
    await runStep(deps, job, { retryCount: 2, retryLimit: 2 });
    run = await getRun(handle.db, runId);
    expect(run).toMatchObject({
      state: "FAILED",
      terminalReason: "LLM_UNAVAILABLE",
    });
    expect(run.error).toMatchObject({
      transient: true,
      failedState: "ANALYZING_INTENT",
    });

    const retried = await postRetry(
      s,
      c.post(`/api/v1/runs/${runId}/retry`, {}),
      { runId },
    );
    expect(retried.status).toBe(202);
    expect(await body(retried)).toMatchObject({
      state: "ANALYZING_INTENT",
      terminalReason: null,
    });
    // The provider recovered: the retried step completes.
    provider.on("r1.intent", { output: INTENT_OUTPUT });
    await drain(deps);
    expect((await getRun(handle.db, runId)).state).toBe(
      "AWAITING_BRIEF_CONFIRMATION",
    );
    expect(
      (await postRetry(s, c.post(`/api/v1/runs/${runId}/retry`, {}), { runId }))
        .status,
    ).toBe(409);
  });
});
