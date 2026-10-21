import { z } from "zod";

// Single source for every enumerated domain value. Database enums are generated from these.

export const ProvenanceClass = z.enum([
  "QLOO_SOURCED",
  "APP_DERIVED",
  "MODEL_INTERPRETATION",
  "CREATIVE_SPECULATION",
  "USER_PROVIDED",
  "DEVELOPMENT_FIXTURE",
]);
export type ProvenanceClass = z.infer<typeof ProvenanceClass>;

export const DataOrigin = z.enum(["LIVE", "CACHE", "REPLAY", "FIXTURE"]);
export type DataOrigin = z.infer<typeof DataOrigin>;

export const QlooTransport = z.enum(["HARNESS_MCP", "HARNESS_CLI", "FIXTURE"]);
export type QlooTransport = z.infer<typeof QlooTransport>;

// Harness envelope statuses (V1-observed) plus a local transport failure.
export const EnvelopeStatus = z.enum([
  "ok",
  "empty",
  "needs_input",
  "partial",
  "degraded",
  "error",
  "transport_error",
]);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatus>;

// V1: harness outputs are heterogeneous; record which shape was received.
export const EnvelopeShape = z.enum([
  "search_array", // qloo api search: top-level array
  "result_list", // results[] (recommend, rank, tags, describe, where_popular, demographics)
  "compare_object", // compare_audiences: results { tags, a, b, matchEntities }
  "series", // trends: series[]
  "needs_input", // resolution.issues[], results []
  "error_object", // bare { error, operation, correlation_id }
  "unknown",
]);
export type EnvelopeShape = z.infer<typeof EnvelopeShape>;

export const UseCase = z.enum([
  "bookstore",
  "cafe",
  "venue",
  "community_event",
  "other",
]);
export const VenueType = z.enum([
  "bookstore",
  "cafe",
  "bar",
  "gallery",
  "library",
  "small_venue",
  "outdoor",
  "online",
  "other",
]);

// Harness workflow type tokens (V1-observed short names).
export const Domain = z.enum([
  "artist",
  "book",
  "brand",
  "destination",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
]);
export type Domain = z.infer<typeof Domain>;

// Legacy/resolution-only types accepted by name-resolving tools (V1).
export const LegacyEntityType = z.enum([
  "locality",
  "actor",
  "album",
  "author",
  "director",
]);

export const EntityKind = z.enum(["entity", "tag", "locality"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const ResolutionStatus = z.enum([
  "PENDING",
  "RESOLVED",
  "AMBIGUOUS",
  "UNRESOLVED",
  "EXCLUDED",
]);
export const ResolutionMethod = z.enum([
  "EXACT_SINGLE",
  "USER_SELECTED",
  "USER_REFINED",
  "SAMPLE_PRESET",
]);

export const ExperimentKind = z.enum(["ROOT", "BRANCH"]);
export const ExperimentStatus = z.enum([
  "PENDING",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "FAILED",
  "CANCELLED",
]);
export const ExperimentMode = z.enum(["live", "replay", "fixture"]);

export const RunKind = z.enum([
  "EXPLORATION",
  "COUNTERFACTUAL",
  "COMPOSITION",
  "REVALIDATION",
]);
export type RunKind = z.infer<typeof RunKind>;

export const RunState = z.enum([
  "QUEUED",
  "ANALYZING_INTENT",
  "AWAITING_BRIEF_CONFIRMATION",
  "RESOLVING_ENTITIES",
  "AWAITING_ENTITY_CONFIRMATION",
  "DISCOVERING",
  "BUILDING_COLLISION_POOL",
  "GENERATING_HYPOTHESES",
  "PLANNING_EVIDENCE",
  "COLLECTING_EVIDENCE",
  "EVALUATING_EVIDENCE",
  "REVISING_HYPOTHESES",
  "AWAITING_HYPOTHESIS_SELECTION",
  "PLANNING_COUNTERFACTUAL",
  "AWAITING_COUNTERFACTUAL_CONFIRMATION",
  "COMPARING",
  "COMPOSING_BLUEPRINT",
  "VALIDATING_BLUEPRINT",
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "FAILED",
  "CANCELLED",
]);
export type RunState = z.infer<typeof RunState>;
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "FAILED",
  "CANCELLED",
];

export const HypothesisStatus = z.enum([
  "SPECULATIVE",
  "UNDER_INVESTIGATION",
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "CONTRADICTED",
  "INCONCLUSIVE",
  "UNTESTABLE",
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

export const ClaimTestKind = z.enum([
  "CROSS_DOMAIN_AFFINITY",
  "SHORTLIST_FIT",
  "AUDIENCE_BRIDGE",
  "TAG_RESONANCE",
  "LOCATION_FIT",
  "MOMENTUM",
  "AUDIENCE_PROFILE",
]);
export type ClaimTestKind = z.infer<typeof ClaimTestKind>;

// UNSUPPORTED: the capability/type combination is rejected upstream (V1: trends + book).
export const ClaimStatus = z.enum([
  "PLANNED",
  "TESTED",
  "UNTESTED_BUDGET",
  "UNSUPPORTED",
  "FAILED",
]);

export const EvidenceStance = z.enum([
  "SUPPORTS",
  "CONTRADICTS",
  "NEUTRAL",
  "INSUFFICIENT",
]);
export type EvidenceStance = z.infer<typeof EvidenceStance>;

export const EvidenceQuality = z.enum([
  "FULL",
  "PARTIAL",
  "DEGRADED",
  "FIELD_UNAVAILABLE",
  "UNSUPPORTED",
  "ERROR",
]);

// What a Qloo-derived number measures. Every value is an aggregate audience signal;
// none of them is a creative-suitability score (V1 finding; ADR-019).
export const QlooMeasure = z.enum([
  "AUDIENCE_AFFINITY",
  "POPULARITY",
  "RANK_POSITION",
  "AUDIENCE_TAG_OVERLAP",
  "GEO_AFFINITY",
  "TREND",
  "DEMOGRAPHIC_INDEX",
  "TAG_ASSOCIATION",
  "NONE",
]);
export type QlooMeasure = z.infer<typeof QlooMeasure>;

export const RelationKind = z.enum([
  "THREAD",
  "BRIDGE_SHARED_TAG",
  "BRIDGE_CO_OCCURRENCE",
  "HAS_TAG",
  "POPULAR_IN",
]);
export const BlueprintStatus = z.enum(["DRAFT", "ACCEPTED"]);
export const BlueprintFormat = z.enum(["event", "series", "installation"]);
export const RevisionAuthor = z.enum(["AGENT", "USER"]);
export const ShareScope = z.enum(["project", "experiment", "blueprint"]);
export const LlmValidationStatus = z.enum([
  "VALID",
  "REPAIRED",
  "INVALID",
  "REFUSED",
  "TRUNCATED",
]);
export const ComparisonKind = z.enum([
  "COUNTERFACTUAL",
  "DATA_DRIFT",
  "AD_HOC",
]);
export const ProjectStatus = z.enum(["active", "archived"]);
export const WorkspaceKind = z.enum(["anonymous", "system"]);
export const AgentRole = z.enum(["R1", "R2", "R3", "R4", "R5", "R6"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
