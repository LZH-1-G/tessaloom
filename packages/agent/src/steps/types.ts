import type {
  BlueprintContent,
  BriefInput,
  CompareSide,
  ComparisonMetrics,
  VariableDelta,
  ClaimParams,
  ClaimTestKind,
  EvidenceFact,
  EvidenceStance,
  ExperimentVariables,
  GuardContext,
  HypothesisDraft,
  HypothesisStatus,
  IntentFrame,
  QlooMeasure,
  RunBudget,
  RunConfig,
  RunEventName,
  RunKind,
  RunState,
  RunUsage,
} from "@tessaloom/core";
import type { UsageDelta } from "../budget";
import type { LlmPort, QlooPort, ResolutionCandidatesLike } from "../ports";

// ---------------------------------------------------------------------------
// Read-only step context (built by the worker from the database)

export interface EntityView {
  id: string;
  kind: "entity" | "tag" | "locality";
  qlooId: string;
  name: string;
  /** Insights type for entities; "tag" for tags; "locality" for localities. */
  domain: string | null;
}

export interface ClaimView {
  id: string;
  ordinal: number;
  statement: string;
  testKind: ClaimTestKind;
  params: ClaimParams;
  status: "PLANNED" | "TESTED" | "UNTESTED_BUDGET" | "UNSUPPORTED" | "FAILED";
  stance: EvidenceStance | null;
}

export interface HypothesisView {
  id: string;
  lineageId: string;
  revisionOfId: string | null;
  iteration: number;
  title: string;
  premise: string;
  experienceSketch: string;
  status: HypothesisStatus;
  retired: boolean;
  compositeScore: number | null;
  collisionCandidateId: string | null;
  scoreBreakdown: Record<string, unknown> | null;
  elements: { entityId: string; role: string }[];
  claims: ClaimView[];
  evidence: {
    id: string;
    claimId: string;
    stance: EvidenceStance;
    toolInvocationId: string | null;
    /** The evaluator's plain-language rule (APP_DERIVED). */
    rationale?: string | null;
    provenanceClass?: string;
  }[];
}

/** COMPOSITION runs: the blueprint being composed (ADR-028). */
export interface BlueprintView {
  id: string;
  format: "event" | "series" | "installation";
  hypothesisIds: string[];
  draft: BlueprintContent | null;
  repairAttempts: number;
  issues: string[];
  recompose: { section: string; instruction: string | null } | null;
  /** The current revision (recompose merges into it). */
  base: BlueprintContent | null;
  baseRevisionId: string | null;
}

export interface ResolutionView {
  id: string;
  interestIndex: number;
  inputText: string;
  domainHint: string | null;
  requestedKind: "entity" | "tag" | "locality";
  status: "PENDING" | "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" | "EXCLUDED";
  selectedEntityId: string | null;
}

export interface PoolCandidateView {
  id: string;
  elementEntityIds: string[];
  relevance: number;
  novelty: number;
  tensionFit: number;
  noveltyInputs: "FULL" | "REDUCED_INPUTS";
  selected: boolean;
  rank: number | null;
}

export interface StepContext {
  inputOrigin?: "synthetic" | "unknown";
  run: {
    id: string;
    kind: RunKind;
    state: RunState;
    stateVersion: number;
    iteration: number;
    budget: RunBudget;
    usage: RunUsage;
    config: RunConfig;
    elapsedSeconds: number;
  };
  experiment: {
    id: string;
    projectId: string;
    variables: ExperimentVariables;
    scoringWeights: { support: number; novelty: number; feasibility: number };
    /** Branches only: the parent experiment and the applied delta (ADR-027). */
    parentExperimentId?: string | null;
    variableDelta?: VariableDelta | null;
  };
  /** COUNTERFACTUAL runs: the dependency plan stored when the branch was created. */
  branch?: {
    plannedDirtyQueries: number;
    plannedReusedQueries: number;
    mode: string;
  } | null;
  /** COMPOSITION runs. */
  blueprint?: BlueprintView | null;
  /** COMPARING: both sides loaded from the database. */
  comparison?: { parent: CompareSide; branch: CompareSide } | null;
  brief: {
    versionId: string;
    content: BriefInput;
    intentFrame: IntentFrame | null;
  };
  resolutions: ResolutionView[];
  /** Experiment seeds (role "seed"): entities and tags. */
  seeds: EntityView[];
  /** The resolved venue locality (role "location"), if any. */
  location: EntityView | null;
  entities: ReadonlyMap<string, EntityView>;
  threads: { seedId: string; entityId: string; position: number }[];
  /** HAS_TAG relations: entity id → tag entity ids (absent = tags unknown). */
  tags: ReadonlyMap<string, readonly string[]>;
  /** Every stored collision candidate (selected and not). */
  pool: PoolCandidateView[];
  hypotheses: HypothesisView[];
  today: string; // YYYY-MM-DD
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Step result: what the worker commits atomically

export type EntityRef =
  string | { kind: "entity" | "tag" | "locality"; qlooId: string };
export type Provenance = "QLOO_SOURCED" | "DEVELOPMENT_FIXTURE";

export interface CommitPlan {
  intent?: {
    briefVersionId: string;
    intentFrame: IntentFrame;
    llmInvocationId: string;
  };
  entities?: {
    kind: "entity" | "tag" | "locality";
    qlooId: string;
    name: string;
    qlooType?: string | null;
    domain?: string | null;
    disambiguation?: string | null;
    legacyType?: boolean;
    snapshot: Record<string, unknown>;
    sourceToolInvocationId: string | null;
    provenanceClass: Provenance;
  }[];
  resolutions?: {
    existingId: string | null;
    interestIndex: number;
    inputText: string;
    domainHint: string | null;
    requestedKind: "entity" | "tag" | "locality";
    candidates: ResolutionCandidatesLike;
    toolInvocationIds: string[];
    status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
    selected: EntityRef | null;
  }[];
  seeds?: { ref: EntityRef; role: "seed" | "location" }[];
  relations?: {
    from: EntityRef;
    to: EntityRef;
    kind:
      | "THREAD"
      | "BRIDGE_SHARED_TAG"
      | "BRIDGE_CO_OCCURRENCE"
      | "HAS_TAG"
      | "POPULAR_IN";
    provenanceClass: Provenance | "APP_DERIVED";
    toolInvocationIds: string[];
    facts: EvidenceFact[];
    weight: number | null;
  }[];
  collisionCandidates?: {
    elementEntityIds: string[];
    relevance: number;
    novelty: number;
    tensionFit: number;
    noveltyInputs: "FULL" | "REDUCED_INPUTS";
    selected: boolean;
    rank: number | null;
  }[];
  /** Re-select the stored pool (gate H2b: the user committed a tension value). */
  poolSelection?: {
    id: string;
    selected: boolean;
    rank: number | null;
    tensionFit: number;
  }[];
  hypotheses?: {
    draft: HypothesisDraft;
    llmInvocationId: string;
    iteration: number;
    revisionOfId: string | null;
    lineageId: string | null;
    collisionCandidateId: string | null;
  }[];
  hypothesisUpdates?: {
    id: string;
    status?: HypothesisStatus;
    supportScore?: number;
    noveltyScore?: number;
    feasibilityScore?: number;
    compositeScore?: number;
    scoreBreakdown?: Record<string, unknown>;
    retired?: boolean;
  }[];
  claimOutcomes?: {
    claimId: string;
    status: ClaimView["status"];
    stance?: EvidenceStance | null;
    queryRequestHash?: string | null;
  }[];
  /** COMPOSITION: the in-progress draft and/or the validated revision. */
  blueprint?: {
    draft?: BlueprintContent | null;
    draftMeta?: Record<string, unknown> | null;
    revision?: {
      content: BlueprintContent;
      traceabilityReport: Record<string, unknown>;
      changeSummary: string;
    };
  };
  /** COMPARING: the parent ↔ branch comparison (APP_DERIVED metrics + narrative). */
  comparison?: {
    baseExperimentId: string;
    otherExperimentId: string;
    metrics: ComparisonMetrics;
    narrative: Record<string, unknown>;
  };
  evidence?: {
    id: string;
    claimId: string;
    hypothesisId: string;
    toolInvocationId: string;
    stance: EvidenceStance;
    evaluatorId: string;
    rulesetVersion: string;
    rationale: string;
    /** Ordered top-K Qloo ids of the graded result (identifiers only; ADR-027). */
    resultIds?: string[] | null;
    facts: EvidenceFact[];
    primaryMeasure: QlooMeasure;
    quality:
      | "FULL"
      | "PARTIAL"
      | "DEGRADED"
      | "FIELD_UNAVAILABLE"
      | "UNSUPPORTED"
      | "ERROR";
    provenanceClass: Provenance;
  }[];
}

export interface StepEvent {
  type: string;
  role?: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | null;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface StepResult {
  event: RunEventName;
  guard: GuardContext;
  commit: CommitPlan;
  events: StepEvent[];
  usage: UsageDelta;
  iteration?: number;
  pendingConfirmation?: Record<string, unknown> | null;
  terminalReason?: string | null;
  error?: { code: string; message: string } | null;
  /** Retry the job instead of failing (transient provider unavailability). */
  transient?: boolean;
}

export interface Ports {
  qloo: QlooPort;
  llm: LlmPort | null;
}
