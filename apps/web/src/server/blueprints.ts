import { BlueprintFormat, BlueprintSectionKind } from "@tessaloom/core";
import {
  blueprintView,
  createProjectShareLink,
  findActiveShareLink,
  exportBlueprint,
  getRevision,
  listBlueprints,
  listShareLinks,
  revokeWorkspaceShareLink,
  runView,
  saveUserRevision,
  setBlueprintStatus,
  sharedView,
  startComposition,
  startRecompose,
  listSamples,
  sampleView,
} from "@tessaloom/db";
import { z } from "zod";
import {
  Uuid,
  assertNoFixtures,
  handle,
  liveWorker,
  requireWorkspace,
} from "./api";
import {
  checkCsrf,
  clientIpHash,
  hashShareToken,
  json,
  randomToken,
  readJson,
} from "./http";
import type { Services } from "./services";

/** M9 blueprints and sharing (API_CONTRACTS §4.6, SECURITY §4.3). */

/** Share responses never leak through referrers, caches, or search engines. */
const SHARE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

const ComposeRequest = z.object({
  hypothesisIds: z.array(z.uuid()).min(1).max(3),
  format: BlueprintFormat.default("event"),
});

// POST /api/v1/experiments/:experimentId/blueprints
export const postBlueprint = handle(
  async (s: Services, req: Request, params: { experimentId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`start:ws:${workspace.id}`, 6);
    s.limiter.check(
      `start:ip:${clientIpHash(req, s.pepper, s.trustedProxyHops)}`,
      20,
    );
    const body = await readJson(req, ComposeRequest);
    const { config } = await liveWorker(s);
    const result = await startComposition(s.handle, await s.boss(), {
      workspaceId: workspace.id,
      experimentId: Uuid.parse(params.experimentId),
      hypothesisIds: body.hypothesisIds,
      format: body.format,
      runConfig: config,
      admission: s.admission,
    });
    return json(result, 202);
  },
);

// GET /api/v1/projects/:projectId/blueprints
export const getProjectBlueprints = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    const workspace = await requireWorkspace(s, req);
    return json({
      items: await listBlueprints(
        s.handle.db,
        workspace.id,
        Uuid.parse(params.projectId),
      ),
    });
  },
);

// GET /api/v1/blueprints/:blueprintId
export const getBlueprint = handle(
  async (s: Services, req: Request, params: { blueprintId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const view = await blueprintView(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.blueprintId),
    );
    assertNoFixtures(s, view);
    return json({
      ...view,
      latestRun: view.latestRun ? runView(view.latestRun) : null,
    });
  },
);

// GET /api/v1/blueprints/:blueprintId/revisions
export const getBlueprintRevisions = handle(
  async (s: Services, req: Request, params: { blueprintId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const view = await blueprintView(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.blueprintId),
    );
    return json({ items: view.revisions });
  },
);

// GET /api/v1/blueprints/:blueprintId/revisions/:revisionId (read-only history view)
export const getBlueprintRevision = handle(
  async (
    s: Services,
    req: Request,
    params: { blueprintId: string; revisionId: string },
  ) => {
    const workspace = await requireWorkspace(s, req);
    const result = await getRevision(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.blueprintId),
      Uuid.parse(params.revisionId),
    );
    assertNoFixtures(s, result);
    return json(result);
  },
);

const RevisionRequest = z.object({
  baseRevisionId: z.uuid(),
  content: z.unknown(),
  restoreOfRevisionNumber: z.number().int().positive().optional(),
});

// POST /api/v1/blueprints/:blueprintId/revisions — a user edit or a restore (EB-4)
export const postBlueprintRevision = handle(
  async (s: Services, req: Request, params: { blueprintId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const body = await readJson(req, RevisionRequest);
    const revision = await saveUserRevision(s.handle, {
      workspaceId: workspace.id,
      blueprintId: Uuid.parse(params.blueprintId),
      baseRevisionId: body.baseRevisionId,
      content: body.content,
      restoreOf: body.restoreOfRevisionNumber ?? null,
    });
    return json(revision, 201);
  },
);

// POST /api/v1/blueprints/:blueprintId/status — Draft ↔ Accepted
export const postBlueprintStatus = handle(
  async (s: Services, req: Request, params: { blueprintId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const { status } = await readJson(
      req,
      z.object({ status: z.enum(["DRAFT", "ACCEPTED"]) }),
    );
    await setBlueprintStatus(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.blueprintId),
      status,
    );
    return new Response(null, { status: 204 });
  },
);

// POST /api/v1/blueprints/:blueprintId/sections/:sectionKind/recompose
export const postRecompose = handle(
  async (
    s: Services,
    req: Request,
    params: { blueprintId: string; sectionKind: string },
  ) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`start:ws:${workspace.id}`, 6);
    const section = BlueprintSectionKind.parse(params.sectionKind);
    const { instruction } = await readJson(
      req,
      z.object({ instruction: z.string().trim().max(300).optional() }),
    );
    const { config } = await liveWorker(s);
    const result = await startRecompose(s.handle, await s.boss(), {
      workspaceId: workspace.id,
      blueprintId: Uuid.parse(params.blueprintId),
      section,
      instruction: instruction || null,
      runConfig: config,
      admission: s.admission,
    });
    return json(result, 202);
  },
);

function download(
  file: { filename: string; contentType: string; body: string },
  extra: Record<string, string> = {},
) {
  return new Response(file.body, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

const ExportFormat = z.enum(["md", "json"]);

// GET /api/v1/blueprints/:blueprintId/export?format=md|json
export const getBlueprintExport = handle(
  async (s: Services, req: Request, params: { blueprintId: string }) => {
    const workspace = await requireWorkspace(s, req);
    const format = ExportFormat.parse(
      new URL(req.url).searchParams.get("format") ?? "md",
    );
    const file = await exportBlueprint(
      s.handle.db,
      { workspaceId: workspace.id },
      Uuid.parse(params.blueprintId),
      format,
    );
    assertNoFixtures(s, file.body);
    return download(file);
  },
);

// --- Share links ---

const ShareRequest = z.object({
  scope: z.enum(["project", "experiment", "blueprint"]),
  targetId: z.uuid(),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

// POST /api/v1/projects/:projectId/share-links — the token is returned once
export const postShareLink = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    const body = await readJson(req, ShareRequest);
    const token = randomToken();
    const link = await createProjectShareLink(s.handle.db, {
      workspaceId: workspace.id,
      projectId: Uuid.parse(params.projectId),
      scope: body.scope,
      targetId: body.targetId,
      tokenHash: hashShareToken(token, s.pepper),
      expiresInDays: body.expiresInDays,
    });
    return json(
      {
        shareLinkId: link.id,
        url: `/share/${token}`,
        expiresAt: link.expiresAt,
      },
      201,
    );
  },
);

// GET /api/v1/projects/:projectId/share-links
export const getShareLinks = handle(
  async (s: Services, req: Request, params: { projectId: string }) => {
    const workspace = await requireWorkspace(s, req);
    return json({
      items: await listShareLinks(
        s.handle.db,
        workspace.id,
        Uuid.parse(params.projectId),
      ),
    });
  },
);

// DELETE /api/v1/share-links/:shareLinkId — revocation is immediate
export const deleteShareLink = handle(
  async (s: Services, req: Request, params: { shareLinkId: string }) => {
    checkCsrf(req);
    const workspace = await requireWorkspace(s, req);
    s.limiter.check(`mutate:ws:${workspace.id}`, 60);
    await revokeWorkspaceShareLink(
      s.handle.db,
      workspace.id,
      Uuid.parse(params.shareLinkId),
    );
    return new Response(null, { status: 204 });
  },
);

const ShareToken = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/);
const inactive = () =>
  json(
    {
      error: {
        code: "NOT_FOUND",
        message: "This link is no longer active.",
      },
    },
    404,
    SHARE_HEADERS,
  );

/** Shared lookup: rate-limited per IP hash, constant "inactive" answer for any failure. */
async function resolveShare(s: Services, req: Request, token: string) {
  s.limiter.check(
    `share:ip:${clientIpHash(req, s.pepper, s.trustedProxyHops)}`,
    30,
  );
  const parsed = ShareToken.safeParse(token);
  if (!parsed.success) return null;
  return sharedView(s.handle.db, hashShareToken(parsed.data, s.pepper));
}

// GET /api/v1/share/:token — read-only, token-scoped payload (no workspace data)
export const getShared = handle(
  async (s: Services, req: Request, params: { token: string }) => {
    const view = await resolveShare(s, req, params.token);
    if (!view) return inactive();
    assertNoFixtures(s, view);
    return json(view, 200, SHARE_HEADERS);
  },
);

// GET /api/v1/share/:token/export?format=md|json — blueprint scope only
export const getSharedExport = handle(
  async (s: Services, req: Request, params: { token: string }) => {
    s.limiter.check(
      `share:ip:${clientIpHash(req, s.pepper, s.trustedProxyHops)}`,
      30,
    );
    const parsed = ShareToken.safeParse(params.token);
    if (!parsed.success) return inactive();
    const link = await findActiveShareLink(
      s.handle.db,
      hashShareToken(parsed.data, s.pepper),
    );
    if (!link || link.scope !== "blueprint") return inactive();
    const format = ExportFormat.parse(
      new URL(req.url).searchParams.get("format") ?? "md",
    );
    const file = await exportBlueprint(
      s.handle.db,
      { shareBlueprintId: link.targetId },
      link.targetId,
      format,
    );
    assertNoFixtures(s, file.body);
    return download(file, SHARE_HEADERS);
  },
);

// --- M10-A read-only demo samples (featured project links; no workspace, no AI runs) ---

// GET /api/v1/samples
export const getSamples = handle(async (s: Services, req: Request) => {
  s.limiter.check(
    `samples:ip:${clientIpHash(req, s.pepper, s.trustedProxyHops)}`,
    60,
  );
  const items = await listSamples(s.handle.db);
  return json({
    items: items
      .filter((i) => s.appEnv !== "production" || !i.fixture)
      .map((i) => ({
        id: i.id,
        scope: i.scope,
        projectName: i.projectName,
        useCase: i.useCase,
        fixture: i.fixture,
      })),
  });
});

// GET /api/v1/samples/:sampleId
export const getSample = handle(
  async (s: Services, req: Request, params: { sampleId: string }) => {
    s.limiter.check(
      `samples:ip:${clientIpHash(req, s.pepper, s.trustedProxyHops)}`,
      60,
    );
    const id = Uuid.safeParse(params.sampleId);
    if (!id.success) return inactive();
    const view = await sampleView(s.handle.db, id.data);
    if (!view) return inactive();
    assertNoFixtures(s, view);
    return json(view, 200, { "Cache-Control": "no-store" });
  },
);
