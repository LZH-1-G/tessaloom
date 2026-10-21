import { z } from "zod";
import {
  RunConfig,
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
  createWorkspace,
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
    const mode = beat.transport === "fixture" ? "fixture" : "live";
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
