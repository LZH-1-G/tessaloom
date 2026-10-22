/** Read-model shapes returned by the API (serialized; dates are ISO strings). */

export type Provenance =
  | "QLOO_SOURCED"
  | "APP_DERIVED"
  | "MODEL_INTERPRETATION"
  | "CREATIVE_SPECULATION"
  | "USER_PROVIDED"
  | "DEVELOPMENT_FIXTURE";
export type DataOrigin = "LIVE" | "CACHE" | "REPLAY" | "FIXTURE";

export interface RunView {
  id: string;
  experimentId: string;
  kind: string;
  state: string;
  stateVersion: number;
  iteration: number;
  budget: {
    maxIterations: number;
    maxQlooCalls: number;
    maxLlmCalls: number;
    maxLlmOutputTokens: number;
    maxEstimatedCostUsd: number;
    wallClockSeconds: number;
  };
  usage: {
    qlooCalls: number;
    llmCalls: number;
    llmInputTokens: number;
    llmOutputTokens: number;
    estimatedCostUsd: number;
  };
  pendingConfirmation: ({ kind: string } & Record<string, unknown>) | null;
  terminalReason: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BriefContent {
  title: string;
  challenge: string;
  interests: { text: string; domainHint?: string }[];
  venue: { type: string; localityText?: string; capacity?: number };
  constraints: {
    budgetBand?: string;
    durationMinutes?: number;
    notes?: string[];
  };
  goals: string[];
}

export interface IntentFrameView {
  interests: { text: string; guessedDomain: string; importance: number }[];
  targetDomains: string[];
  venue: { type: string; locality?: string; capacity?: number };
  constraints: {
    budgetBand?: string;
    durationMinutes?: number;
    notes?: string[];
  };
  goals: string[];
  ambiguities: { interestIndex: number; question: string }[];
  decisionSummary: string;
}

export interface BriefVersion {
  id: string;
  version: number;
  content: BriefContent;
  intentFrame?: IntentFrameView | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    useCase: string;
    status: string;
    updatedAt: string;
    currentBriefVersionId: string | null;
  };
  briefs: BriefVersion[];
  experiments: {
    id: string;
    briefVersionId: string;
    status: string;
    mode: string;
    kind: string;
    createdAt: string;
    latestRun: RunView | null;
  }[];
}

export interface Candidate {
  qlooId: string;
  name: string;
  type?: string;
  popularity?: number;
  description?: string;
  disambiguation?: string;
  legacyType: boolean;
  source: "selected" | "alternative" | "issue_candidate" | "search";
  rankInSource: number;
}
export interface TagCandidateView {
  tagId: string;
  name: string;
  tagType?: string;
  popularity?: number;
  rankInSource: number;
}

export interface ResolutionView {
  id: string;
  interestIndex: number | null;
  inputText: string;
  domainHint: string | null;
  requestedKind: "entity" | "tag" | "locality";
  status: "PENDING" | "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" | "EXCLUDED";
  method: string | null;
  selectedEntityId: string | null;
  candidates: {
    entities: Candidate[];
    tags: TagCandidateView[];
    harnessSelectedQlooId?: string;
  };
  toolInvocationIds: string[];
}

export interface EntityView {
  id: string;
  kind: "entity" | "tag" | "locality";
  qlooId: string;
  qlooType: string | null;
  domain: string | null;
  name: string;
  disambiguation: string | null;
  legacyType: boolean;
  snapshot: Record<string, unknown>;
  sourceToolInvocationId: string | null;
  provenanceClass: Provenance;
  dataOrigin: DataOrigin | null;
  retrievedAt: string | null;
}

export interface Fact {
  statement: string;
  jsonPointer: string;
  value: unknown;
  measure: string;
  verifiedAtIngest: boolean;
}

export interface RelationView {
  id: string;
  kind:
    | "THREAD"
    | "BRIDGE_SHARED_TAG"
    | "BRIDGE_CO_OCCURRENCE"
    | "HAS_TAG"
    | "POPULAR_IN";
  fromEntityId: string;
  toEntityId: string;
  weight: number | null;
  provenanceClass: Provenance;
  facts: Fact[];
  toolInvocationIds: string[];
}

export interface PoolCandidateRow {
  id: string;
  elementEntityIds: string[];
  relevance: number;
  novelty: number;
  tensionFit: number;
  noveltyInputs: "FULL" | "REDUCED_INPUTS";
  selected: boolean;
  rank: number | null;
}

export interface EvidenceView {
  id: string;
  claimId: string;
  stance: "SUPPORTS" | "CONTRADICTS" | "NEUTRAL" | "INSUFFICIENT";
  evaluatorId: string;
  rulesetVersion: string;
  facts: Fact[];
  primaryMeasure: string;
  quality: string;
  provenanceClass: Provenance;
  criticNote: string | null;
  /** Plain-language rule the evaluator applied (APP_DERIVED). */
  rationale: string | null;
  toolInvocationId: string | null;
  dataOrigin: DataOrigin | null;
  retrievedAt: string | null;
}

export interface ClaimRow {
  id: string;
  ordinal: number;
  statement: string;
  testKind: string;
  testParams: Record<string, unknown>;
  status: string;
  currentStance: EvidenceView["stance"] | null;
}

export interface HypothesisRow {
  id: string;
  lineageId: string;
  revisionOfId: string | null;
  iteration: number;
  title: string;
  premise: string;
  experienceSketch: string;
  creativeElements: { text: string; provenance: "CREATIVE_SPECULATION" }[];
  status: string;
  supportScore: number | null;
  noveltyScore: number | null;
  feasibilityScore: number | null;
  compositeScore: number | null;
  scoreBreakdown: Record<string, unknown> | null;
  retired: boolean;
  userPinned: boolean;
  elements: { entityId: string; role: string }[];
  claims: ClaimRow[];
  evidence: EvidenceView[];
}

export interface ExperimentViewData {
  experiment: {
    id: string;
    projectId: string;
    briefVersionId: string;
    experimentKey: string;
    status: string;
    mode: string;
    kind: string;
    createdAt: string;
    definition: {
      seeds?: { qlooId: string; kind: string; role: string }[];
      variableDelta?: Record<string, unknown> | null;
      variables: {
        targetDomains: string[];
        collisionTension: number;
        timeWindowWeeks?: number;
        locationQlooId?: string | null;
        constraints?: {
          capacity?: number;
          budgetBand?: string;
          durationMinutes?: number;
        };
      };
      scoringWeights: { support: number; novelty: number; feasibility: number };
    };
  };
  brief: BriefVersion | null;
  runs: RunView[];
  llmProviders: string[];
  resolutions: ResolutionView[];
  seeds: { entityId: string; role: string; ordinal: number }[];
  entities: EntityView[];
  relations: RelationView[];
  pool: PoolCandidateRow[];
  hypotheses: HypothesisRow[];
}

export interface SystemStatus {
  workerOnline: boolean;
  mode: "live" | "fixture" | null;
  qlooTransport: string | null;
  qlooReady: boolean;
  harnessVersion: string | null;
  llmModel: string | null;
}

export interface RunEventView {
  seq: number;
  ts: string;
  type: string;
  state: string;
  role: string | null;
  summary: string;
  payload: Record<string, unknown>;
}

// --- M8 What-if (API_CONTRACTS §4.5, §6.12) ---

export interface BranchPreview {
  dirtyQueries: number;
  reusedQueries: number;
  estimatedQlooCalls: number;
  rescoreOnly: boolean;
  needsConfirmation: boolean;
  dirtyList: { method: string; label: string; reason: string }[];
  claims: {
    reuse: number;
    inherit: number;
    dirty: number;
    unsupported: number;
  };
  unsupported: string[];
  mode: string;
  qlooCallsToday: number;
}

export interface BranchItem {
  id: string;
  kind: "ROOT" | "BRANCH";
  label: string | null;
  parentExperimentId: string | null;
  status: string;
  createdAt: string;
  variableDelta: Record<string, unknown> | null;
  plannedDirtyQueries: number | null;
  plannedReusedQueries: number | null;
  latestRun: RunView | null;
  comparisonId: string | null;
}

export interface ComparisonRow {
  id: string;
  baseExperimentId: string;
  otherExperimentId: string;
  comparisonKind: string;
  metrics: import("@tessaloom/core").ComparisonMetrics;
  dirtyQueries: number;
  reusedQueries: number;
  newQlooResults: number;
  narrative: {
    text: string;
    rendered: string;
    citedEvidenceIds: string[];
    provenance: "MODEL_INTERPRETATION" | "APP_DERIVED";
    source: string;
  } | null;
  createdAt: string;
}
