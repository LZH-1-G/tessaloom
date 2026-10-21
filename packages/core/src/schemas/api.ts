import { z } from "zod";
import { BlueprintFormat, Domain, ShareScope, UseCase } from "../enums";
import { BriefInput } from "./domain";
import {
  ExperimentVariables,
  ScoringWeights,
  VariableDelta,
} from "./experiment";

// API_CONTRACTS §3.3
export const ApiErrorCode = z.enum([
  "VALIDATION_FAILED",
  "WORKSPACE_REQUIRED",
  "FORBIDDEN",
  "CSRF_FAILED",
  "SHARE_LINK_REVOKED",
  "NOT_FOUND",
  "STATE_CONFLICT",
  "IDEMPOTENCY_MISMATCH",
  "BRIEF_INSUFFICIENT",
  "DELTA_EMPTY",
  "RATE_LIMITED",
  "QUOTA_GUARD_ACTIVE",
  "WORKER_OFFLINE",
  "QLOO_UNAVAILABLE",
  "LLM_UNAVAILABLE",
]);

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string().min(1),
    retryable: z.boolean(),
    requestId: z.string().min(1),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// API_CONTRACTS §4 request bodies
export const CreateProjectRequest = z.object({
  name: z.string().trim().min(1).max(80),
  useCase: UseCase,
});
export const CreateBriefRequest = BriefInput;
export const StartExperimentRequest = z.object({
  briefVersionId: z.uuid(),
  variables: ExperimentVariables.partial().optional(),
  scoringWeights: ScoringWeights.optional(),
  mode: z.literal("live"),
});
export const ConfirmationResponse = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("BRIEF"),
    briefVersionId: z.uuid(),
    action: z.literal("confirm"),
    // H1 editable chips (UI_UX_SPEC §4.2): the user's domain for an interest overrides the
    // model's guess and becomes the resolution type hint (USER_PROVIDED).
    interestDomains: z
      .array(
        z.object({
          interestIndex: z.number().int().min(0).max(5),
          domain: z.union([Domain, z.literal("unknown")]),
        }),
      )
      .max(6)
      .optional(),
  }),
  z.object({
    kind: z.literal("ENTITIES"),
    selections: z
      .array(
        z.object({
          interestIndex: z.number().int().min(0),
          choice: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("candidate"),
              qlooId: z.string().min(1),
            }),
            z.object({
              type: z.literal("refine"),
              text: z.string().trim().min(1).max(120),
            }),
            z.object({ type: z.literal("exclude") }),
          ]),
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal("HYPOTHESIS_SELECTION"),
    selectedHypothesisIds: z.array(z.uuid()).max(3),
  }),
  z.object({
    kind: z.literal("COUNTERFACTUAL_COST"),
    action: z.enum(["run", "cancel"]),
    maxQlooCalls: z.number().int().min(1).max(15).optional(),
  }),
]);
export type ConfirmationResponse = z.infer<typeof ConfirmationResponse>;
export const CreateBranchRequest = z.object({
  delta: VariableDelta,
  mode: z.enum(["hold_hypotheses", "regenerate"]).default("hold_hypotheses"),
  label: z.string().trim().max(80).optional(),
});
export const ResolveRequest = z.object({
  text: z.string().trim().min(1).max(120),
  domainHint: z.string().optional(),
  kind: z.enum(["entity", "tag", "locality"]),
});
export const ComposeBlueprintRequest = z.object({
  hypothesisIds: z.array(z.uuid()).min(1).max(3),
  format: BlueprintFormat,
});
export const CreateShareLinkRequest = z.object({
  scope: ShareScope,
  targetId: z.uuid(),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
