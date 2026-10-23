import { CritiqueReport, HypothesisBatch } from "../../packages/core/src";
import {
  combine,
  critiqueValidator,
  hypothesisBatchValidator,
  safeUseValidator,
} from "../../packages/agent/src/validators";

// Entirely invented locally. No Qloo snapshots, entities, scores or audience data.
export const QUALITY_PLAN = {
  id: "deepseek-synthetic-quality-v1",
  model: "deepseek-v4-pro",
  maxRequests: 2,
  maxInputBytesPerRequest: 16384,
  maxOutputTokensPerRequest: 8192,
  maxTotalOutputTokens: 16384,
  budgetCny: 2,
  usdPerCny: 0.2, // Proposed conservative accounting rate, reviewed against 2026-10-23 FX.
  estimatedReservationCny: 0.811008,
  estimatedReservationUsd: 0.1622016,
  effort: "low" as const,
  retries: 0,
};
export const SYNTHETIC_ENTITIES = [
  {
    entityId: "11111111-1111-4111-8111-111111111111",
    name: "Paper Atlas Stories",
    domain: "book",
  },
  {
    entityId: "22222222-2222-4222-8222-222222222222",
    name: "Velvet Static Radio",
    domain: "artist",
  },
  {
    entityId: "33333333-3333-4333-8333-333333333333",
    name: "Lantern Ferry Sketches",
    domain: "movie",
  },
];
export const SYNTHETIC_HYPOTHESIS_ID = "44444444-4444-4444-8444-444444444444";
export const SYNTHETIC_EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";
const fixtureLabel = {
  inputOrigin: "SYNTHETIC_LOCAL",
  description:
    "All names, identifiers and evidence are locally invented test material, not Qloo facts.",
};
export const generationInput = {
  fixture: fixtureLabel,
  brief: {
    title: "Paper Lantern Listening Room",
    challenge:
      "Create two distinct book, music and film collisions for a small cafe; every proposal remains an untested cultural hypothesis.",
    goals: ["Offer an accessible conversation-led evening"],
    venue: { type: "cafe", capacity: 24 },
    constraints: {
      budgetBand: "low",
      durationMinutes: 90,
      notes: ["No audience demand, sales or attendance evidence exists."],
    },
  },
  seeds: [SYNTHETIC_ENTITIES[0], SYNTHETIC_ENTITIES[1]],
  discovered: SYNTHETIC_ENTITIES,
  pool: [
    {
      candidateId: "66666666-6666-4666-8666-666666666666",
      rank: 1,
      elements: [SYNTHETIC_ENTITIES[0], SYNTHETIC_ENTITIES[1]],
    },
    {
      candidateId: "77777777-7777-4777-8777-777777777777",
      rank: 2,
      elements: [SYNTHETIC_ENTITIES[0], SYNTHETIC_ENTITIES[2]],
    },
  ],
  limits: { maxHypotheses: 2, maxClaimsPerHypothesis: 3 },
  allowedTestKinds: [
    "CROSS_DOMAIN_AFFINITY",
    "SHORTLIST_FIT",
    "AUDIENCE_BRIDGE",
  ],
};
export const critiqueInput = {
  fixture: fixtureLabel,
  hypotheses: [
    {
      hypothesisId: SYNTHETIC_HYPOTHESIS_ID,
      title: "Guaranteed sell-out listening room",
      premise:
        "A deliberately unsupported claim: shared tastes guarantee a sold-out event and increased sales.",
      status: "INSUFFICIENT",
      claims: [
        {
          statement:
            "An invented affinity signal proves attendance and revenue will increase.",
          testKind: "CROSS_DOMAIN_AFFINITY",
          status: "INSUFFICIENT",
          stance: "INCONCLUSIVE",
          evidence: [
            {
              evidenceId: SYNTHETIC_EVIDENCE_ID,
              stance: "INCONCLUSIVE",
              summary:
                "Synthetic aggregate taste overlap only; no attendance, revenue, causal or individual-level observations exist.",
            },
          ],
        },
      ],
    },
  ],
};
export const validateGeneration = combine(
  hypothesisBatchValidator({
    entityIds: new Set(SYNTHETIC_ENTITIES.map((e) => e.entityId)),
    domainOf: new Map(SYNTHETIC_ENTITIES.map((e) => [e.entityId, e.domain])),
    maxClaimsPerHypothesis: 3,
  }),
  safeUseValidator,
  (value: HypothesisBatch) =>
    value.hypotheses.length === 2
      ? []
      : [
          {
            code: "QUALITY_CASE",
            message: "The fixed quality case requires two hypotheses",
          },
        ],
);
export const validateCritique = combine(
  critiqueValidator({
    hypothesisIds: new Set([SYNTHETIC_HYPOTHESIS_ID]),
    evidenceByHypothesis: new Map([
      [SYNTHETIC_HYPOTHESIS_ID, new Set([SYNTHETIC_EVIDENCE_ID])],
    ]),
  }),
  safeUseValidator,
  (value: CritiqueReport) =>
    value.perHypothesis.length === 1 &&
    value.perHypothesis[0]!.recommendation !== "keep" &&
    value.perHypothesis[0]!.citedEvidenceIds.includes(SYNTHETIC_EVIDENCE_ID)
      ? []
      : [
          {
            code: "QUALITY_CASE",
            message:
              "Unsupported causal conclusion must be challenged with the supplied synthetic evidence",
          },
        ],
);
export const generationCase = {
  role: "R3" as const,
  promptId: "r3.generate",
  input: generationInput,
  schema: HypothesisBatch,
  validate: validateGeneration,
  effort: QUALITY_PLAN.effort,
  maxOutputTokens: QUALITY_PLAN.maxOutputTokensPerRequest,
};
export const critiqueCase = {
  role: "R4" as const,
  promptId: "r4.critique",
  input: critiqueInput,
  schema: CritiqueReport,
  validate: validateCritique,
  effort: QUALITY_PLAN.effort,
  maxOutputTokens: QUALITY_PLAN.maxOutputTokensPerRequest,
};
