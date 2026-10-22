import { asc, eq } from "drizzle-orm";
import {
  ClaimTestKind,
  EvidenceFact,
  type EvidenceStance,
  type QlooMeasure,
  uuidv7,
} from "@tessaloom/core";
import { z } from "zod";
import type { Executor, Tx } from "../client";
import { DomainRuleError } from "../errors";
import {
  evidenceRecords,
  hypotheses,
  hypothesisClaims,
  hypothesisElements,
} from "../schema";

export async function insertHypothesis(
  tx: Tx,
  input: {
    experimentId: string;
    runId: string;
    llmInvocationId: string;
    iteration: number;
    title: string;
    premise: string;
    experienceSketch: string;
    creativeElements?: { text: string; provenance: "CREATIVE_SPECULATION" }[];
    scoringVersion: string;
    collisionCandidateId?: string | null;
    revisionOfId?: string | null;
    lineageId?: string | null;
    inheritedFromId?: string | null;
    elements: { entityId: string; role: "anchor" | "accent" | "context" }[];
    claims: {
      statement: string;
      testKind: z.infer<typeof ClaimTestKind>;
      testParams: Record<string, unknown>;
      dependsOn?: string[];
    }[];
  },
) {
  if (input.elements.length < 2 || input.elements.length > 4) {
    throw new DomainRuleError("A hypothesis needs 2–4 grounded elements");
  }
  if (input.claims.length < 1 || input.claims.length > 3) {
    throw new DomainRuleError("A hypothesis needs 1–3 claims");
  }
  const id = uuidv7();
  const [hypothesis] = await tx
    .insert(hypotheses)
    .values({
      id,
      experimentId: input.experimentId,
      runId: input.runId,
      llmInvocationId: input.llmInvocationId,
      collisionCandidateId: input.collisionCandidateId ?? null,
      lineageId: input.lineageId ?? id,
      revisionOfId: input.revisionOfId ?? null,
      inheritedFromId: input.inheritedFromId ?? null,
      iteration: input.iteration,
      title: input.title,
      premise: input.premise,
      experienceSketch: input.experienceSketch,
      creativeElements: input.creativeElements ?? [],
      status: "SPECULATIVE",
      scoringVersion: input.scoringVersion,
    })
    .returning();
  await tx.insert(hypothesisElements).values(
    input.elements.map((element) => ({
      hypothesisId: id,
      entityId: element.entityId,
      role: element.role,
    })),
  );
  const claims = await tx
    .insert(hypothesisClaims)
    .values(
      input.claims.map((claim, ordinal) => ({
        id: uuidv7(),
        hypothesisId: id,
        ordinal,
        statement: claim.statement,
        testKind: claim.testKind,
        testParams: claim.testParams,
        status: "PLANNED" as const,
        dependsOn: claim.dependsOn ?? [],
      })),
    )
    .returning();
  return { hypothesis: hypothesis!, claims };
}

export async function setClaimOutcome(
  db: Executor,
  input: {
    claimId: string;
    status: "PLANNED" | "TESTED" | "UNTESTED_BUDGET" | "UNSUPPORTED" | "FAILED";
    stance?: EvidenceStance | null;
    queryRequestHash?: string | null;
  },
) {
  await db
    .update(hypothesisClaims)
    .set({
      status: input.status,
      ...(input.stance !== undefined ? { currentStance: input.stance } : {}),
      ...(input.queryRequestHash !== undefined
        ? { queryRequestHash: input.queryRequestHash }
        : {}),
    })
    .where(eq(hypothesisClaims.id, input.claimId));
}

/**
 * Insert one immutable evidence record. Facts are validated; each states its measure, and
 * Qloo-derived measures describe aggregate audience signals, never creative suitability.
 */
export async function insertEvidence(
  db: Executor,
  input: {
    id?: string; // pre-generated so the critic can cite evidence before it is committed
    claimId: string;
    hypothesisId: string;
    experimentId: string;
    runId: string;
    toolInvocationId: string | null;
    stance: EvidenceStance;
    evaluatorId: string;
    rulesetVersion: string;
    facts: z.input<typeof EvidenceFact>[];
    primaryMeasure: QlooMeasure;
    quality:
      | "FULL"
      | "PARTIAL"
      | "DEGRADED"
      | "FIELD_UNAVAILABLE"
      | "UNSUPPORTED"
      | "ERROR";
    provenanceClass: "QLOO_SOURCED" | "APP_DERIVED" | "DEVELOPMENT_FIXTURE";
    rationale?: string | null;
    /** Ordered top-K Qloo ids of the graded result (identifiers only). */
    resultIds?: string[] | null;
    criticNote?: string | null;
    criticDowngrade?: boolean;
  },
) {
  const facts = z.array(EvidenceFact).parse(input.facts);
  const [row] = await db
    .insert(evidenceRecords)
    .values({
      id: input.id ?? uuidv7(),
      claimId: input.claimId,
      hypothesisId: input.hypothesisId,
      experimentId: input.experimentId,
      runId: input.runId,
      toolInvocationId: input.toolInvocationId,
      stance: input.stance,
      evaluatorId: input.evaluatorId,
      rulesetVersion: input.rulesetVersion,
      facts,
      primaryMeasure: input.primaryMeasure,
      quality: input.quality,
      provenanceClass: input.provenanceClass,
      rationale: input.rationale ?? null,
      resultIds: input.resultIds?.slice(0, 50) ?? null,
      criticNote: input.criticNote ?? null,
      criticDowngrade: input.criticDowngrade ?? false,
    })
    .returning();
  return row!;
}

export async function listEvidenceForHypothesis(
  db: Executor,
  hypothesisId: string,
) {
  return db
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.hypothesisId, hypothesisId))
    .orderBy(asc(evidenceRecords.createdAt));
}

export async function listClaims(db: Executor, hypothesisId: string) {
  return db
    .select()
    .from(hypothesisClaims)
    .where(eq(hypothesisClaims.hypothesisId, hypothesisId))
    .orderBy(asc(hypothesisClaims.ordinal));
}
