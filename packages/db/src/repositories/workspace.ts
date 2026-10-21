import { and, desc, eq, max, sql } from "drizzle-orm";
import {
  BriefInput,
  canonicalHash,
  uuidv7,
  type IntentFrame,
} from "@tessaloom/core";
import type { Executor, Tx } from "../client";
import { NotFoundError } from "../errors";
import { briefVersions, projects, workspaces } from "../schema";

// --- Workspaces (anonymous owners; only an HMAC of the cookie secret is stored) ---

export async function createWorkspace(
  db: Executor,
  input: { secretHash: string; kind?: "anonymous" | "system" },
) {
  const [row] = await db
    .insert(workspaces)
    .values({
      id: uuidv7(),
      secretHash: input.secretHash,
      kind: input.kind ?? "anonymous",
    })
    .returning();
  return row!;
}

export async function findWorkspaceBySecretHash(
  db: Executor,
  secretHash: string,
) {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.secretHash, secretHash));
  return row ?? null;
}

export async function touchWorkspace(db: Executor, workspaceId: string) {
  // At most hourly, to avoid a write per request.
  await db
    .update(workspaces)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        sql`${workspaces.lastSeenAt} < now() - interval '1 hour'`,
      ),
    );
}

// --- Projects (every read is scoped by workspace) ---

export async function createProject(
  db: Executor,
  input: {
    workspaceId: string;
    name: string;
    useCase: "bookstore" | "cafe" | "venue" | "community_event" | "other";
  },
) {
  const [row] = await db
    .insert(projects)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      name: input.name,
      useCase: input.useCase,
    })
    .returning();
  return row!;
}

export async function getProject(
  db: Executor,
  workspaceId: string,
  projectId: string,
) {
  const [row] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)),
    );
  if (!row) throw new NotFoundError("Project not found");
  return row;
}

export async function listProjects(
  db: Executor,
  workspaceId: string,
  status: "active" | "archived" = "active",
) {
  return db
    .select()
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.status, status)),
    )
    .orderBy(desc(projects.updatedAt));
}

// --- Brief versions (append-only; DATABASE_SCHEMA §6 "Create brief version") ---

export async function createBriefVersion(
  tx: Tx,
  input: { projectId: string; content: unknown },
) {
  const content = BriefInput.parse(input.content);
  // Serialize concurrent writers per project so versions stay gap-free and unique.
  await tx.execute(
    sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`,
  );
  const [current] = await tx
    .select({ value: max(briefVersions.version) })
    .from(briefVersions)
    .where(eq(briefVersions.projectId, input.projectId));
  const version = (current?.value ?? 0) + 1;
  const [row] = await tx
    .insert(briefVersions)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      version,
      content,
      contentHash: canonicalHash(content),
    })
    .returning();
  await tx
    .update(projects)
    .set({ currentBriefVersionId: row!.id, updatedAt: sql`now()` })
    .where(eq(projects.id, input.projectId));
  return row!;
}

export async function getBriefVersion(db: Executor, briefVersionId: string) {
  const [row] = await db
    .select()
    .from(briefVersions)
    .where(eq(briefVersions.id, briefVersionId));
  if (!row) throw new NotFoundError("Brief version not found");
  return row;
}

export async function listBriefVersions(db: Executor, projectId: string) {
  return db
    .select()
    .from(briefVersions)
    .where(eq(briefVersions.projectId, projectId))
    .orderBy(desc(briefVersions.version));
}

export async function setIntentFrame(
  db: Executor,
  input: {
    briefVersionId: string;
    intentFrame: IntentFrame;
    llmInvocationId: string;
  },
) {
  await db
    .update(briefVersions)
    .set({
      intentFrame: input.intentFrame,
      intentLlmInvocationId: input.llmInvocationId,
    })
    .where(eq(briefVersions.id, input.briefVersionId));
}

export async function confirmBriefVersion(
  db: Executor,
  briefVersionId: string,
) {
  await db
    .update(briefVersions)
    .set({ confirmedAt: sql`now()` })
    .where(eq(briefVersions.id, briefVersionId));
}
