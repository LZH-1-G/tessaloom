import { z } from "zod";
import {
  CreateBriefRequest,
  CreateProjectRequest,
  RunConfig,
  buildEvidenceGraph,
  StartExperimentRequest,
  canonicalHash,
  isPaused,
  isTerminal,
  type RunState,
} from "@tessaloom/core";
import {
  cancelRun,
  confirmRun,
  consumeWithinLimit,
  createBriefVersion,
  createProject,
  createWorkspace,
  evidenceTrace,
  experimentView,
  getGraphLayout,
  invocationTrace,
  saveGraphLayout,
  getBriefVersion,
  getProject,
  listProjects,
  projectOverview,
  withTx,
  findIdempotentResponse,
  findWorkspaceBySecretHash,
  getRunForWorkspace,
  latestHeartbeat,
  listRunEventsAfter,
  retryRun,
  runView,
  startExploration,
  storeIdempotentResponse,
  touchWorkspace,
} from "@tessaloom/db";
import {
  CSRF_COOKIE,
  HttpError,
  WORKSPACE_COOKIE,
  checkCsrf,
  clientIpHash,
  cookie,
  errorResponse,
  hashWorkspaceSecret,
  json,
  parseCookies,
  randomToken,
  readJson,
} from "./http";
import type { Services } from "./services";

const Uuid = z.uuid();

async function requireWorkspace(s: Services, req: Request) {
  const secret = parseCookies(req)[WORKSPACE_COOKIE];
  if (!secret)
    throw new HttpError("WORKSPACE_REQUIRED", "A workspace is required.");
  const workspace = await findWorkspaceBySecretHash(
    s.handle.db,
    hashWorkspaceSecret(secret, s.sessionSecret),
  );
  if (!workspace)
    throw new HttpError("WORKSPACE_REQUIRED", "A workspace is required.");
  return workspace;
}

/** A fresh heartbeat with a published run configuration, or 503 WORKER_OFFLINE. */
async function liveWorker(s: Services) {
  const beat = await latestHeartbeat(s.handle.db);
  const fresh =
    beat && s.now().getTime() - beat.lastBeatAt.getTime() < s.heartbeatMaxAgeMs;
  const config = RunConfig.safeParse(beat?.runConfig);
  if (!fresh || !config.success)
    throw new HttpError(
      "WORKER_OFFLINE",
      "The agent worker is offline. Please try again shortly.",
    );
  return { beat: beat!, config: config.data };
}

const handle =
  <A extends unknown[]>(fn: (...args: A) => Promise<Response>) =>
  async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };

// GET /api/v1/workspace — issues the workspace and CSRF cookies on first visit.
export const getWorkspace = handle(async (s: Services, req: Request) => {
  const cookies = parseCookies(req);
  const headers = new Headers();
  let workspace = cookies[WORKSPACE_COOKIE]
    ? await findWorkspaceBySecretHash(
        s.handle.db,
        hashWorkspaceSecret(cookies[WORKSPACE_COOKIE]!, s.sessionSecret),
      )
    : null;
  if (!workspace) {
    s.limiter.check(`ws-create:${clientIpHash(req, s.pepper)}`, 20);
    const secret = randomToken();
    workspace = await createWorkspace(s.handle.db, {
      secretHash: hashWorkspaceSecret(secret, s.sessionSecret),
    });
    headers.append(
      "Set-Cookie",
      cookie(WORKSPACE_COOKIE, secret, {
        httpOnly: true,
        secure: s.secureCookies,
      }),
    );
  } else {
    await touchWorkspace(s.handle.db, workspace.id);
  }
  if (!cookies[CSRF_COOKIE])
    // Readable by the page script, which echoes it in the X-Tessaloom-CSRF header.
    headers.append(
      "Set-Cookie",
      cookie(CSRF_COOKIE, randomToken(), {
        httpOnly: false,
        secure: s.secureCookies,
      }),
    );
  return json(
    { id: workspace.id, createdAt: workspace.createdAt.toISOString() },
    200,
    headers,
  );
});

// POST /api/v1/projects/:projectId/experiments
export const startExperiment = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    const projectId = Uuid.parse(params.projectId);
    s.limiter.check(`start:ws:${workspace.id}`, 6);
    s.limiter.check(`start:ip:${clientIpHash(req, s.pepper)}`, 20);
    const body = await readJson(req, StartExperimentRequest);
    const key = req.headers.get("idempotency-key");
    const requestHash = canonicalHash({ projectId, body });
    if (key) {
      Uuid.parse(key);
      const prior = await findIdempotentResponse(
        s.handle.db,
        workspace.id,
        key,
      );
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new HttpError(
            "IDEMPOTENCY_MISMATCH",
            "This Idempotency-Key was used with a different request.",
          );
        return json(prior.response, 202);
      }
    }
    const { beat, config } = await liveWorker(s);
    const mode =
      beat.transport === "fixture" || beat.transport === "synthetic"
        ? "fixture"
        : "live";
    if (mode === "live") {
      const used = await consumeWithinLimit(s.handle.db, {
        scope: "workspace",
        scopeId: workspace.id,
        metric: "live_runs",
        limit: s.dailyRunsPerWorkspace,
      });
      if (used === null)
        throw new HttpError(
          "QUOTA_GUARD_ACTIVE",
          "This workspace has used today's live experiments. Sample projects remain available.",
        );
    }
    const result = await startExploration(s.handle, await s.boss(), {
      workspaceId: workspace.id,
      projectId,
      briefVersionId: body.briefVersionId,
      variables: body.variables,
      scoringWeights: body.scoringWeights,
      mode,
      runConfig: config,
    });
    if (key)
      await storeIdempotentResponse(s.handle.db, {
        workspaceId: workspace.id,
        key,
        requestHash,
        response: result,
      });
    return json(result, 202);
  },
);

// GET /api/v1/runs/:runId
export const getRun = handle(
  async (s: Services, req: Request, params: { runId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const { run } = await getRunForWorkspace(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.runId),
    );
    return json(runView(run));
  },
);

const mutation = (
  op: (
    s: Services,
    workspaceId: string,
    runId: string,
    req: Request,
  ) => Promise<unknown>,
) =>
  handle(async (s: Services, req: Request, params: { runId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const runId = Uuid.parse(params.runId);
    return json(await op(s, workspace.id, runId, req), 202);
  });

// POST /api/v1/runs/:runId/confirmations
export const postConfirmation = mutation(async (s, workspaceId, runId, req) =>
  confirmRun(
    s.handle,
    await s.boss(),
    workspaceId,
    runId,
    await readJson(req, z.unknown()),
  ),
);
// POST /api/v1/runs/:runId/cancel
export const postCancel = mutation(async (s, workspaceId, runId) =>
  cancelRun(s.handle, await s.boss(), workspaceId, runId),
);
// POST /api/v1/runs/:runId/retry
export const postRetry = mutation(async (s, workspaceId, runId) =>
  retryRun(s.handle, await s.boss(), workspaceId, runId),
);

// GET /api/v1/runs/:runId/events — SSE with Last-Event-ID resume (API_CONTRACTS §10).
export const streamEvents = handle(
  async (s: Services, req: Request, params: { runId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const runId = Uuid.parse(params.runId);
    await getRunForWorkspace(s.handle.db, workspace.id, runId);
    const url = new URL(req.url);
    const resume =
      req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
    let after = z.coerce.number().int().min(0).parse(resume);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const started = Date.now();
        let lastPing = Date.now();
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        };
        req.signal.addEventListener("abort", close);
        const tick = async () => {
          if (closed) return;
          try {
            const events = await listRunEventsAfter(
              s.handle.db,
              runId,
              after,
              200,
            );
            for (const e of events) {
              const data = {
                seq: e.seq,
                ts: e.ts.toISOString(),
                type: e.type,
                state: e.state,
                role: e.role,
                summary: e.summary,
                payload: e.payload,
              };
              controller.enqueue(
                encoder.encode(
                  `id: ${e.seq}\nevent: run-event\ndata: ${JSON.stringify(data)}\n\n`,
                ),
              );
              after = e.seq;
            }
            if (events.length < 200) {
              const { run } = await getRunForWorkspace(
                s.handle.db,
                workspace.id,
                runId,
              );
              const state = run.state as RunState;
              // Close once a terminal or paused state is reached and fully flushed.
              if (
                (isTerminal(state) || isPaused(state)) &&
                (await listRunEventsAfter(s.handle.db, runId, after, 1))
                  .length === 0
              ) {
                controller.enqueue(
                  encoder.encode(
                    `event: run-terminal\ndata: ${JSON.stringify({ state, lastSeq: after })}\n\n`,
                  ),
                );
                return close();
              }
            }
            if (Date.now() - lastPing >= s.sse.pingMs) {
              controller.enqueue(encoder.encode(": ping\n\n"));
              lastPing = Date.now();
            }
            if (Date.now() - started > s.sse.maxDurationMs) return close(); // client reconnects
            timer = setTimeout(
              () => void tick(),
              events.length === 200 ? 0 : s.sse.pollMs,
            );
          } catch {
            close();
          }
        };
        void tick();
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
);

// --- Projects and briefs (API_CONTRACTS §4.1, §4.2) ---

// POST /api/v1/projects
export const postProject = handle(async (s: Services, req: Request) => {
  checkCsrf(req);
  const workspace = await requireWorkspace(s, req);
  s.limiter.check(`mutate:ws:${workspace.id}`, 60);
  const body = await readJson(req, CreateProjectRequest);
  const project = await createProject(s.handle.db, {
    workspaceId: workspace.id,
    ...body,
  });
  return json(project, 201);
});

// GET /api/v1/projects
export const getProjects = handle(async (s: Services, req: Request) => {
  const workspace = await requireWorkspace(s, req);
  const items = await listProjects(s.handle.db, workspace.id);
  const overviews = await Promise.all(
    items.map((p) => projectOverview(s.handle.db, workspace.id, p.id)),
  );
  return json({
    items: overviews.map((o) => ({
      ...o.project,
      briefCount: o.briefs.length,
      latestExperiment: o.experiments[0]
        ? {
            id: o.experiments[0].id,
            status: o.experiments[0].status,
            latestRun: o.experiments[0].latestRun
              ? runView(o.experiments[0].latestRun)
              : null,
          }
        : null,
    })),
    nextCursor: null,
  });
});

// GET /api/v1/projects/:projectId
export const getProjectDetail = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const overview = await projectOverview(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.projectId),
    );
    return json({
      ...overview,
      experiments: overview.experiments.map((e) => ({
        ...e,
        latestRun: e.latestRun ? runView(e.latestRun) : null,
      })),
    });
  },
);

// POST /api/v1/projects/:projectId/briefs — a new append-only brief version.
export const postBrief = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const projectId = Uuid.parse(params.projectId);
    await getProject(s.handle.db, workspace.id, projectId);
    const body = await readJson(req, CreateBriefRequest);
    const brief = await withTx(s.handle.db, (tx) =>
      createBriefVersion(tx, { projectId, content: body }),
    );
    return json(brief, 201);
  },
);

// GET /api/v1/briefs/:briefVersionId
export const getBrief = handle(
  async (s: Services, req: Request, params: { briefVersionId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const brief = await getBriefVersion(
      s.handle.db,
      Uuid.parse(params.briefVersionId),
    );
    await getProject(s.handle.db, workspace.id, brief.projectId);
    return json(brief);
  },
);

/** AGENT_WORKFLOW §13.1: fixture-derived records are never served by a production build. */
function assertNoFixtures(s: Services, value: unknown) {
  if (
    s.appEnv === "production" &&
    JSON.stringify(value).includes('"DEVELOPMENT_FIXTURE"')
  )
    throw new HttpError(
      "FORBIDDEN",
      "Development fixtures cannot be served in production.",
    );
}

// GET /api/v1/experiments/:experimentId
export const getExperiment = handle(
  async (s: Services, req: Request, params: { experimentId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const view = await experimentView(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.experimentId),
    );
    assertNoFixtures(s, view);
    return json({ ...view, runs: view.runs.map(runView) });
  },
);

// GET /api/v1/experiments/:experimentId/graph?include=threads,retired
export const getExperimentGraph = handle(
  async (s: Services, req: Request, params: { experimentId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const id = Uuid.parse(params.experimentId);
    const view = await experimentView(s.handle.db, workspace.id, id);
    assertNoFixtures(s, view);
    const include = new Set(
      (new URL(req.url).searchParams.get("include") ?? "").split(","),
    );
    const graph = buildEvidenceGraph(view, {
      includeThreads: include.has("threads"),
      includeRetired: include.has("retired"),
    });
    return json({ ...graph, layout: await getGraphLayout(s.handle.db, id) });
  },
);

const GraphLayoutRequest = z.object({
  positions: z
    .array(
      z.object({
        nodeId: z.uuid(),
        x: z.number().finite().min(-1e5).max(1e5),
        y: z.number().finite().min(-1e5).max(1e5),
      }),
    )
    .max(2000),
});

// PUT /api/v1/experiments/:experimentId/graph-layout
export const putGraphLayout = handle(
  async (s: Services, req: Request, params: { experimentId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const id = Uuid.parse(params.experimentId);
    // Ownership check: throws 404 for another workspace's experiment.
    await experimentView(s.handle.db, workspace.id, id);
    const { positions } = await readJson(req, GraphLayoutRequest);
    await saveGraphLayout(
      s.handle.db,
      id,
      Object.fromEntries(positions.map((p) => [p.nodeId, { x: p.x, y: p.y }])),
    );
    return new Response(null, { status: 204 });
  },
);

// GET /api/v1/evidence/:evidenceId/trace
export const getEvidenceTrace = handle(
  async (s: Services, req: Request, params: { evidenceId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const trace = await evidenceTrace(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.evidenceId),
    );
    assertNoFixtures(s, trace);
    return json(trace);
  },
);

// GET /api/v1/system/status — mode badge, worker banner, Qloo readiness (UI_UX_SPEC §3).
export const getSystemStatus = handle(async (s: Services) => {
  const beat = await latestHeartbeat(s.handle.db);
  const online =
    !!beat &&
    s.now().getTime() - beat.lastBeatAt.getTime() < s.heartbeatMaxAgeMs;
  const transport = beat?.transport ?? null;
  return json({
    workerOnline: online,
    mode:
      transport === "fixture" || transport === "synthetic"
        ? "fixture"
        : transport
          ? "live"
          : null,
    qlooTransport: transport,
    qlooReady: online && !!beat?.qlooReady,
    harnessVersion: beat?.harnessVersion ?? null,
    llmModel:
      (beat?.runConfig as { llmModel?: string } | null)?.llmModel ?? null,
  });
});

// GET /api/v1/invocations/:invocationId — request-to-result trace for one Qloo call.
export const getInvocationTrace = handle(
  async (s: Services, req: Request, params: { invocationId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const trace = await invocationTrace(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.invocationId),
    );
    return json(trace);
  },
);
