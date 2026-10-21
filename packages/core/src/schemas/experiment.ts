import { z } from "zod";
import { AgentRole, Domain, Effort } from "../enums";
import { QlooId } from "./qloo";

export const AgeBand = z.enum(["18-24", "25-34", "35-44", "45-54", "55+"]);

export const ScoringWeights = z
  .object({
    support: z.number().min(0).max(1),
    novelty: z.number().min(0).max(1),
    feasibility: z.number().min(0).max(1),
  })
  .refine(
    (w) => Math.abs(w.support + w.novelty + w.feasibility - 1) < 1e-9,
    "Scoring weights must sum to 1",
  );
export const DEFAULT_SCORING_WEIGHTS = {
  support: 0.4,
  novelty: 0.35,
  feasibility: 0.25,
};

const VenueConstraints = z.object({
  capacity: z.number().int().positive().optional(),
  budgetBand: z.enum(["low", "medium", "high"]).optional(),
  durationMinutes: z.number().int().positive().optional(),
});

export const ExperimentVariables = z.object({
  targetDomains: z.array(Domain).min(1),
  tagConstraints: z.array(QlooId).default([]),
  locationQlooId: QlooId.nullable().default(null),
  audienceBand: AgeBand.nullable().default(null),
  timeWindowWeeks: z
    .union([z.literal(4), z.literal(12), z.literal(26), z.literal(52)])
    .default(12),
  collisionTension: z.number().min(0.2).max(0.9).default(0.5),
  constraints: VenueConstraints.default({}),
});
export type ExperimentVariables = z.infer<typeof ExperimentVariables>;

export const VariableDelta = z
  .object({
    seeds: z
      .object({
        add: z.array(z.uuid()).optional(),
        remove: z.array(z.uuid()).optional(),
        swap: z.array(z.object({ from: z.uuid(), to: z.uuid() })).optional(),
      })
      .optional(),
    targetDomains: z
      .object({
        add: z.array(Domain).optional(),
        remove: z.array(Domain).optional(),
      })
      .optional(),
    tagConstraints: z
      .object({
        add: z.array(QlooId).optional(),
        remove: z.array(QlooId).optional(),
      })
      .optional(),
    location: z.object({ localityEntityId: z.uuid() }).nullable().optional(),
    audienceBand: z.object({ ageBand: AgeBand }).nullable().optional(),
    timeWindow: z
      .object({
        weeks: z.union([
          z.literal(4),
          z.literal(12),
          z.literal(26),
          z.literal(52),
        ]),
      })
      .optional(),
    collisionTension: z.number().min(0.2).max(0.9).optional(),
    scoringWeights: ScoringWeights.optional(),
    // No default here: an omitted field must stay undefined so empty deltas are rejected.
    constraints: VenueConstraints.optional(),
  })
  .refine(
    (d) => Object.values(d).some((v) => v !== undefined),
    "Delta must change something",
  );
export type VariableDelta = z.infer<typeof VariableDelta>;

export const RunBudget = z.object({
  maxIterations: z.number().int().min(0).max(10),
  maxHypotheses: z.number().int().min(0).max(12),
  maxClaimsPerHypothesis: z.number().int().min(0).max(3),
  maxQlooCalls: z.number().int().min(0).max(100),
  maxLlmCalls: z.number().int().min(0).max(50),
  maxLlmOutputTokens: z.number().int().min(0),
  maxEstimatedCostUsd: z.number().min(0),
  wallClockSeconds: z.number().int().min(1),
});
export type RunBudget = z.infer<typeof RunBudget>;

// AGENT_WORKFLOW §7 (cost caps per ADR-018).
export const DEFAULT_BUDGETS = {
  EXPLORATION: {
    maxIterations: 3,
    maxHypotheses: 6,
    maxClaimsPerHypothesis: 3,
    maxQlooCalls: 40,
    maxLlmCalls: 14,
    maxLlmOutputTokens: 60_000,
    maxEstimatedCostUsd: 2.0,
    wallClockSeconds: 420,
  },
  COUNTERFACTUAL: {
    maxIterations: 1,
    maxHypotheses: 0,
    maxClaimsPerHypothesis: 3,
    maxQlooCalls: 15,
    maxLlmCalls: 4,
    maxLlmOutputTokens: 15_000,
    maxEstimatedCostUsd: 0.4,
    wallClockSeconds: 180,
  },
  COMPOSITION: {
    maxIterations: 0,
    maxHypotheses: 0,
    maxClaimsPerHypothesis: 0,
    maxQlooCalls: 4,
    maxLlmCalls: 3,
    maxLlmOutputTokens: 20_000,
    maxEstimatedCostUsd: 0.7,
    wallClockSeconds: 180,
  },
  REVALIDATION: {
    maxIterations: 1,
    maxHypotheses: 0,
    maxClaimsPerHypothesis: 3,
    maxQlooCalls: 40,
    maxLlmCalls: 1,
    maxLlmOutputTokens: 4_000,
    maxEstimatedCostUsd: 0.15,
    wallClockSeconds: 240,
  },
} as const satisfies Record<string, RunBudget>;

export const RunUsage = z.object({
  qlooCalls: z.number().int().min(0).default(0),
  llmCalls: z.number().int().min(0).default(0),
  llmInputTokens: z.number().int().min(0).default(0),
  llmOutputTokens: z.number().int().min(0).default(0),
  estimatedCostUsd: z.number().min(0).default(0),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const RunConfig = z.object({
  llmModel: z.string().min(1),
  llmFallbackModel: z.string().min(1),
  effortByRole: z.record(AgentRole, Effort),
  promptVersions: z.record(z.string(), z.string()),
  qlooAdapterVersion: z.string().min(1),
  harnessVersion: z.string().min(1),
  evaluationRulesetVersion: z.string().min(1),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const ExperimentSeed = z.object({
  qlooId: QlooId,
  kind: z.enum(["entity", "tag"]),
  role: z.enum(["seed", "tag_constraint", "location"]),
});

/** AGENT_WORKFLOW §14.1. Hashed with JCS + SHA-256 to give the deterministic experiment key. */
export const ExperimentDefinition = z.object({
  schemaVersion: z.literal(1),
  briefContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  seeds: z.array(ExperimentSeed).min(1),
  variables: ExperimentVariables,
  scoringWeights: ScoringWeights,
  budgets: RunBudget,
  versions: z.object({
    evaluationRuleset: z.string().min(1),
    promptSet: z.string().min(1),
    qlooAdapter: z.string().min(1),
    harness: z.string().min(1),
    llmModel: z.string().min(1),
  }),
  parentExperimentKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  variableDelta: VariableDelta.nullable(),
});
export type ExperimentDefinition = z.infer<typeof ExperimentDefinition>;
