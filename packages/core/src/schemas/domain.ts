import { z } from "zod";
import {
  BlueprintFormat,
  ClaimTestKind,
  Domain,
  ProvenanceClass,
  VenueType,
} from "../enums";

export const Uuid = z.uuid();

export const BriefInput = z.object({
  title: z.string().trim().min(1).max(120),
  challenge: z.string().trim().min(20).max(2000),
  interests: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(120),
        domainHint: Domain.optional(),
      }),
    )
    .min(2)
    .max(6)
    .refine(
      (items) =>
        new Set(items.map((i) => i.text.toLowerCase())).size === items.length,
      "Duplicate interests are not allowed",
    ),
  venue: z.object({
    type: VenueType,
    localityText: z.string().trim().min(1).max(120).optional(),
    capacity: z.number().int().min(1).max(5000).optional(),
  }),
  constraints: z
    .object({
      budgetBand: z.enum(["low", "medium", "high"]).optional(),
      durationMinutes: z
        .number()
        .int()
        .min(15)
        .max(24 * 60)
        .optional(),
      notes: z.array(z.string().trim().min(1).max(140)).max(10).optional(),
    })
    .default({}),
  goals: z.array(z.string().trim().min(1).max(140)).max(5).default([]),
});
export type BriefInput = z.infer<typeof BriefInput>;

const DecisionSummary = z.string().min(1).max(280);

export const IntentFrame = z.object({
  interests: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        guessedDomain: z.union([Domain, z.literal("unknown")]),
        importance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .min(2)
    .max(6),
  targetDomains: z.array(Domain).min(1),
  venue: z.object({
    type: VenueType,
    locality: z.string().optional(),
    capacity: z.number().int().positive().optional(),
  }),
  constraints: z.object({
    budgetBand: z.enum(["low", "medium", "high"]).optional(),
    durationMinutes: z.number().int().positive().optional(),
    notes: z.array(z.string()).optional(),
  }),
  goals: z.array(z.string()),
  ambiguities: z.array(
    z.object({
      interestIndex: z.number().int().min(0),
      question: z.string().min(1),
    }),
  ),
  decisionSummary: DecisionSummary,
});
export type IntentFrame = z.infer<typeof IntentFrame>;

export const TestParams = z.record(z.string(), z.unknown());

export const HypothesisDraft = z.object({
  tempId: z.string().min(1),
  title: z.string().min(1).max(80),
  premise: z.string().min(1).max(400),
  elementRefs: z
    .array(
      z.object({
        entityId: Uuid,
        role: z.enum(["anchor", "accent", "context"]),
      }),
    )
    .min(2)
    .max(4),
  claims: z
    .array(
      z.object({
        tempId: z.string().min(1),
        statement: z.string().min(1).max(200),
        testKind: ClaimTestKind,
        params: TestParams,
      }),
    )
    .min(1)
    .max(3),
  creativeElements: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        provenance: z.literal("CREATIVE_SPECULATION"),
      }),
    )
    .default([]),
  experienceSketch: z.string().min(1).max(600),
});
export type HypothesisDraft = z.infer<typeof HypothesisDraft>;

export const HypothesisBatch = z.object({
  hypotheses: z.array(HypothesisDraft).min(1).max(6),
  decisionSummary: DecisionSummary,
});

export const QlooMethod = z.enum([
  "searchEntities",
  "describeEntity",
  "findTags",
  "entityTags",
  "recommend",
  "rank",
  "compareAudiences",
  "audienceDemographics",
  "wherePopular",
  "trends",
]);
export type QlooMethod = z.infer<typeof QlooMethod>;

export const EvidencePlan = z.object({
  queries: z
    .array(
      z.object({
        claimTempId: z.string().min(1),
        method: QlooMethod,
        args: z.record(z.string(), z.unknown()),
        dependsOn: z.array(z.string()),
        priority: z.number().int().min(0),
      }),
    )
    .max(40),
  decisionSummary: DecisionSummary,
});

export const CritiqueReport = z.object({
  perHypothesis: z.array(
    z.object({
      hypothesisId: Uuid,
      confidenceNote: z.string().max(400).optional(),
      citedEvidenceIds: z.array(Uuid),
      downgrade: z.object({ reason: z.string().min(1) }).optional(),
      recommendation: z.enum(["keep", "refine", "retire"]),
      refinementHint: z.string().max(300).optional(),
    }),
  ),
  continueLoop: z.boolean(),
  decisionSummary: DecisionSummary,
});

export const BlueprintSectionKind = z.enum([
  "audience",
  "programming",
  "atmosphere",
  "partners",
  "promotion",
  "logistics",
  "risks",
  "measurement",
]);

export const BlueprintBlock = z.object({
  text: z.string().min(1).max(2000),
  provenance: ProvenanceClass,
  evidenceIds: z.array(Uuid),
});

export const BlueprintContent = z.object({
  title: z.string().min(1).max(120),
  format: BlueprintFormat,
  concept: z.string().min(1).max(2000),
  sections: z.array(
    z.object({ kind: BlueprintSectionKind, blocks: z.array(BlueprintBlock) }),
  ),
  constraintsIdentified: z.array(
    z.object({
      constraint: z.string().min(1),
      severity: z.enum(["info", "caution", "blocking"]),
      evidenceIds: z.array(Uuid),
    }),
  ),
  openQuestions: z.array(z.string()),
});
export type BlueprintContent = z.infer<typeof BlueprintContent>;
