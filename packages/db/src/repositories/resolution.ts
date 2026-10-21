import { and, eq, sql } from "drizzle-orm";
import { type EntityKind, ResolutionCandidates, uuidv7 } from "@tessaloom/core";
import { z } from "zod";
import type { Executor, Tx } from "../client";
import { DomainRuleError, NotFoundError } from "../errors";
import { culturalEntities, entityResolutionRecords } from "../schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One bound parameter holding a Postgres array literal (drizzle expands JS arrays into lists). */
function uuidArrayLiteral(ids: string[]): string {
  for (const id of ids) {
    if (!UUID.test(id)) throw new DomainRuleError("Invalid tool invocation id");
  }
  return `{${ids.join(",")}}`;
}

// --- Cultural entities (canonical local record per workspace, kind, and Qloo ID) ---

export async function upsertCulturalEntity(
  db: Executor,
  input: {
    workspaceId: string;
    kind: EntityKind;
    qlooId: string;
    name: string;
    qlooType?: string | null;
    domain?: string | null;
    disambiguation?: string | null;
    legacyType?: boolean;
    snapshot: Record<string, unknown>; // normalized fields actually returned (+ missingFields)
    sourceToolInvocationId?: string | null;
    provenanceClass: "QLOO_SOURCED" | "DEVELOPMENT_FIXTURE";
  },
) {
  const values = {
    name: input.name,
    qlooType: input.qlooType ?? null,
    domain: input.domain ?? null,
    disambiguation: input.disambiguation ?? null,
    legacyType: input.legacyType ?? false,
    snapshot: input.snapshot,
    provenanceClass: input.provenanceClass,
  };
  const [row] = await db
    .insert(culturalEntities)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      qlooId: input.qlooId,
      sourceToolInvocationId: input.sourceToolInvocationId ?? null,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        culturalEntities.workspaceId,
        culturalEntities.kind,
        culturalEntities.qlooId,
      ],
      set: { ...values, lastRefreshedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function findCulturalEntity(
  db: Executor,
  input: { workspaceId: string; kind: EntityKind; qlooId: string },
) {
  const [row] = await db
    .select()
    .from(culturalEntities)
    .where(
      and(
        eq(culturalEntities.workspaceId, input.workspaceId),
        eq(culturalEntities.kind, input.kind),
        eq(culturalEntities.qlooId, input.qlooId),
      ),
    );
  return row ?? null;
}

// --- Resolution records (gate H2). V1: never auto-accept a harness "exact" match. ---

export async function createResolution(
  db: Executor,
  input: {
    projectId: string;
    inputText: string;
    requestedKind: EntityKind;
    briefVersionId?: string | null;
    runId?: string | null;
    interestIndex?: number | null;
    domainHint?: string | null;
  },
) {
  const [row] = await db
    .insert(entityResolutionRecords)
    .values({
      id: uuidv7(),
      projectId: input.projectId,
      inputText: input.inputText,
      requestedKind: input.requestedKind,
      briefVersionId: input.briefVersionId ?? null,
      runId: input.runId ?? null,
      interestIndex: input.interestIndex ?? null,
      domainHint: input.domainHint ?? null,
      status: "PENDING",
    })
    .returning();
  return row!;
}

/**
 * Store every candidate the harness returned (selected pick, alternatives, ambiguity
 * candidates, and /search disambiguation results). The status is AMBIGUOUS whenever more
 * than one candidate exists, so the user must confirm; a single candidate is UNRESOLVED
 * until confirmed unless the caller explicitly applies the EXACT_SINGLE rule via selectCandidate.
 */
export async function recordResolutionCandidates(
  db: Executor,
  input: {
    resolutionId: string;
    candidates: z.input<typeof ResolutionCandidates>;
    toolInvocationIds: string[];
  },
) {
  const candidates = ResolutionCandidates.parse(input.candidates);
  const total = candidates.entities.length + candidates.tags.length;
  const status =
    total === 0 ? "UNRESOLVED" : total > 1 ? "AMBIGUOUS" : "UNRESOLVED";
  const [row] = await db
    .update(entityResolutionRecords)
    .set({
      candidates,
      status,
      toolInvocationIds: sql`array_cat(${entityResolutionRecords.toolInvocationIds}, ${uuidArrayLiteral(input.toolInvocationIds)}::uuid[])`,
    })
    .where(eq(entityResolutionRecords.id, input.resolutionId))
    .returning();
  if (!row) throw new NotFoundError("Resolution not found");
  return row;
}

/** Confirm one offered candidate. Selecting an entity that was never offered is rejected. */
export async function selectResolutionCandidate(
  tx: Tx,
  input: {
    resolutionId: string;
    entityId: string;
    method: "EXACT_SINGLE" | "USER_SELECTED" | "USER_REFINED" | "SAMPLE_PRESET";
  },
) {
  const [record] = await tx
    .select()
    .from(entityResolutionRecords)
    .where(eq(entityResolutionRecords.id, input.resolutionId))
    .for("update");
  if (!record) throw new NotFoundError("Resolution not found");
  const [entity] = await tx
    .select()
    .from(culturalEntities)
    .where(eq(culturalEntities.id, input.entityId));
  if (!entity) throw new NotFoundError("Entity not found");

  const candidates = ResolutionCandidates.parse(record.candidates);
  const offered = new Set([
    ...candidates.entities.map((c) => c.qlooId),
    ...candidates.tags.map((c) => c.tagId),
  ]);
  if (!offered.has(entity.qlooId)) {
    throw new DomainRuleError(
      "Selected entity was not among the offered candidates",
    );
  }
  if (input.method === "EXACT_SINGLE" && offered.size !== 1) {
    throw new DomainRuleError("EXACT_SINGLE requires exactly one candidate");
  }
  const [row] = await tx
    .update(entityResolutionRecords)
    .set({
      status: "RESOLVED",
      method: input.method,
      selectedEntityId: input.entityId,
      confirmedAt: sql`now()`,
    })
    .where(eq(entityResolutionRecords.id, input.resolutionId))
    .returning();
  return row!;
}

export async function excludeResolution(db: Executor, resolutionId: string) {
  await db
    .update(entityResolutionRecords)
    .set({ status: "EXCLUDED", confirmedAt: sql`now()` })
    .where(eq(entityResolutionRecords.id, resolutionId));
}

export async function getResolution(db: Executor, resolutionId: string) {
  const [row] = await db
    .select()
    .from(entityResolutionRecords)
    .where(eq(entityResolutionRecords.id, resolutionId));
  if (!row) throw new NotFoundError("Resolution not found");
  return row;
}
