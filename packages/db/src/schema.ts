import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AgentRole,
  BlueprintFormat,
  BlueprintStatus,
  ClaimStatus,
  ClaimTestKind,
  ComparisonKind,
  DataOrigin,
  EntityKind,
  EnvelopeShape,
  EnvelopeStatus,
  EvidenceQuality,
  EvidenceStance,
  ExperimentKind,
  ExperimentMode,
  ExperimentStatus,
  HypothesisStatus,
  LlmValidationStatus,
  ProjectStatus,
  ProvenanceClass,
  QlooMeasure,
  QlooTransport,
  RelationKind,
  ResolutionMethod,
  ResolutionStatus,
  RevisionAuthor,
  RunKind,
  RunState,
  ShareScope,
  UseCase,
  WorkspaceKind,
} from "@tessaloom/core";

// Zod 4 types `.options` as an array; Drizzle needs a non-empty tuple of the same values.
function values<T extends string>(zodEnum: {
  options: readonly T[];
}): [T, ...T[]] {
  const [first, ...rest] = zodEnum.options;
  if (first === undefined) throw new Error("Enum must have at least one value");
  return [first, ...rest];
}

// DATABASE_SCHEMA.md §2: Postgres enums generated from the Zod enums in @tessaloom/core.
export const workspaceKind = pgEnum("workspace_kind", values(WorkspaceKind));
export const projectStatus = pgEnum("project_status", values(ProjectStatus));
export const useCase = pgEnum("use_case", values(UseCase));
export const entityKind = pgEnum("entity_kind", values(EntityKind));
export const resolutionStatus = pgEnum(
  "resolution_status",
  values(ResolutionStatus),
);
export const resolutionMethod = pgEnum(
  "resolution_method",
  values(ResolutionMethod),
);
export const experimentKind = pgEnum("experiment_kind", values(ExperimentKind));
export const experimentStatus = pgEnum(
  "experiment_status",
  values(ExperimentStatus),
);
export const experimentMode = pgEnum("experiment_mode", values(ExperimentMode));
export const runKind = pgEnum("run_kind", values(RunKind));
export const runState = pgEnum("run_state", values(RunState));
export const dataOrigin = pgEnum("data_origin", values(DataOrigin));
export const qlooTransport = pgEnum("qloo_transport", values(QlooTransport));
export const envelopeStatus = pgEnum("envelope_status", values(EnvelopeStatus));
export const envelopeShape = pgEnum("envelope_shape", values(EnvelopeShape));
export const provenanceClass = pgEnum(
  "provenance_class",
  values(ProvenanceClass),
);
export const hypothesisStatus = pgEnum(
  "hypothesis_status",
  values(HypothesisStatus),
);
export const claimTestKind = pgEnum("claim_test_kind", values(ClaimTestKind));
export const claimStatus = pgEnum("claim_status", values(ClaimStatus));
export const evidenceStance = pgEnum("evidence_stance", values(EvidenceStance));
export const evidenceQuality = pgEnum(
  "evidence_quality",
  values(EvidenceQuality),
);
export const qlooMeasure = pgEnum("qloo_measure", values(QlooMeasure));
export const relationKind = pgEnum("relation_kind", values(RelationKind));
export const blueprintStatus = pgEnum(
  "blueprint_status",
  values(BlueprintStatus),
);
export const blueprintFormat = pgEnum(
  "blueprint_format",
  values(BlueprintFormat),
);
export const revisionAuthor = pgEnum("revision_author", values(RevisionAuthor));
export const shareScope = pgEnum("share_scope", values(ShareScope));
export const llmValidationStatus = pgEnum(
  "llm_validation_status",
  values(LlmValidationStatus),
);
export const comparisonKind = pgEnum("comparison_kind", values(ComparisonKind));
export const agentRole = pgEnum("agent_role", values(AgentRole));

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const hash64 = (name: string) => char(name, { length: 64 });

// 4.1
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    secretHash: hash64("secret_hash").notNull().unique(),
    kind: workspaceKind("kind").notNull().default("anonymous"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("workspaces_last_seen_idx").on(t.lastSeenAt)],
);

// 4.2 (current_brief_version_id FK is added as DEFERRABLE in the custom migration)
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    useCase: useCase("use_case").notNull(),
    status: projectStatus("status").notNull().default("active"),
    currentBriefVersionId: uuid("current_brief_version_id"),
    sampleSourceId: text("sample_source_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("projects_workspace_idx").on(
      t.workspaceId,
      t.status,
      t.updatedAt.desc(),
    ),
    check("projects_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  ],
);

// 4.13 (declared early: brief_versions references it)
export const llmInvocations = pgTable(
  "llm_invocations",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: agentRole("role").notNull(),
    promptId: text("prompt_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    effort: text("effort").notNull(),
    inputHash: hash64("input_hash").notNull(),
    inputExcerpt: jsonb("input_excerpt").notNull(),
    output: jsonb("output"),
    validationStatus: llmValidationStatus("validation_status").notNull(),
    validationErrors: jsonb("validation_errors"),
    repairOfId: uuid("repair_of_id").references(
      (): AnyPgColumn => llmInvocations.id,
    ),
    stopReason: text("stop_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 4 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("llm_invocations_run_idx").on(t.runId, t.createdAt),
    index("llm_invocations_project_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

// 4.3
export const briefVersions = pgTable(
  "brief_versions",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    contentHash: hash64("content_hash").notNull(),
    intentFrame: jsonb("intent_frame"),
    intentLlmInvocationId: uuid("intent_llm_invocation_id").references(
      () => llmInvocations.id,
    ),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("brief_versions_project_version_uq").on(t.projectId, t.version),
    index("brief_versions_project_idx").on(t.projectId, t.createdAt.desc()),
    check("brief_versions_version_positive", sql`${t.version} >= 1`),
  ],
);

// 4.11
export const qlooResponseSnapshots = pgTable(
  "qloo_response_snapshots",
  {
    id: uuid("id").primaryKey(),
    requestHash: hash64("request_hash").notNull(),
    workflow: text("workflow").notNull(),
    transport: qlooTransport("transport").notNull(),
    harnessVersion: text("harness_version").notNull(),
    envelopeStatus: envelopeStatus("envelope_status").notNull(),
    envelopeShape: envelopeShape("envelope_shape").notNull(),
    resultCount: integer("result_count"),
    // Raw retention is OFF until Qloo/organizer storage permission is confirmed (R-08).
    rawRetained: boolean("raw_retained").notNull().default(false),
    raw: jsonb("raw"),
    rawBytes: integer("raw_bytes"),
    isFixture: boolean("is_fixture").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    pinned: boolean("pinned").notNull().default(false),
  },
  (t) => [
    index("snapshots_request_idx").on(t.requestHash, t.retrievedAt.desc()),
    index("snapshots_expiry_idx")
      .on(t.expiresAt)
      .where(sql`NOT ${t.pinned}`),
    check(
      "snapshots_raw_retention",
      sql`${t.rawRetained} = (${t.raw} IS NOT NULL)`,
    ),
    check(
      "snapshots_raw_bytes",
      sql`${t.rawBytes} IS NULL OR ${t.rawBytes} <= 2000000`,
    ),
  ],
);

// 4.6
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    briefVersionId: uuid("brief_version_id")
      .notNull()
      .references(() => briefVersions.id, { onDelete: "restrict" }),
    kind: experimentKind("kind").notNull(),
    parentExperimentId: uuid("parent_experiment_id").references(
      (): AnyPgColumn => experiments.id,
      { onDelete: "restrict" },
    ),
    rootExperimentId: uuid("root_experiment_id").references(
      (): AnyPgColumn => experiments.id,
    ),
    experimentKey: hash64("experiment_key").notNull(),
    definition: jsonb("definition").notNull(),
    label: text("label"),
    status: experimentStatus("status").notNull().default("PENDING"),
    mode: experimentMode("mode").notNull(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("experiments_project_key_uq").on(t.projectId, t.experimentKey),
    index("experiments_project_idx").on(t.projectId, t.createdAt.desc()),
    index("experiments_parent_idx").on(t.parentExperimentId),
    index("experiments_root_idx").on(t.rootExperimentId),
    check(
      "experiments_branch_parent",
      sql`(${t.kind} = 'BRANCH') = (${t.parentExperimentId} IS NOT NULL)`,
    ),
    check(
      "experiments_label_len",
      sql`${t.label} IS NULL OR char_length(${t.label}) <= 80`,
    ),
  ],
);

// 4.9 (blueprint_id FK added in the custom migration to avoid a declaration cycle)
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    blueprintId: uuid("blueprint_id"),
    kind: runKind("kind").notNull(),
    state: runState("state").notNull().default("QUEUED"),
    stateVersion: integer("state_version").notNull().default(0),
    iteration: smallint("iteration").notNull().default(0),
    budget: jsonb("budget").notNull(),
    usage: jsonb("usage").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    pendingConfirmation: jsonb("pending_confirmation"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    error: jsonb("error"),
    traceId: char("trace_id", { length: 32 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_runs_experiment_idx").on(t.experimentId, t.createdAt.desc()),
    index("agent_runs_active_idx")
      .on(t.state)
      .where(
        sql`${t.state} NOT IN ('COMPLETED','COMPLETED_WITH_LIMITS','FAILED','CANCELLED')`,
      ),
    check("agent_runs_iteration", sql`${t.iteration} BETWEEN 0 AND 10`),
    check("agent_runs_state_version", sql`${t.stateVersion} >= 0`),
  ],
);

// 4.12
export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stepSeq: integer("step_seq"),
    purpose: text("purpose").notNull(),
    method: text("method").notNull(),
    workflow: text("workflow").notNull(),
    transport: qlooTransport("transport").notNull(),
    argsRedacted: jsonb("args_redacted").notNull(),
    requestHash: hash64("request_hash").notNull(),
    snapshotId: uuid("snapshot_id").references(() => qlooResponseSnapshots.id, {
      onDelete: "restrict",
    }),
    dataOrigin: dataOrigin("data_origin").notNull(),
    cacheSourceInvocationId: uuid("cache_source_invocation_id").references(
      (): AnyPgColumn => toolInvocations.id,
    ),
    envelopeStatus: envelopeStatus("envelope_status").notNull(),
    envelopeShape: envelopeShape("envelope_shape").notNull(),
    resultCount: integer("result_count"),
    errorCode: text("error_code"),
    // Harness-reported provenance (V1): correlation id, endpoint, and the exact GET requests.
    correlationId: text("correlation_id"),
    harnessEndpoint: text("harness_endpoint"),
    harnessRequests: jsonb("harness_requests")
      .notNull()
      .default(sql`'[]'::jsonb`),
    attempt: smallint("attempt").notNull().default(1),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tool_invocations_run_idx").on(t.runId, t.stepSeq),
    index("tool_invocations_project_idx").on(t.projectId, t.createdAt.desc()),
    index("tool_invocations_request_idx").on(t.requestHash),
    check(
      "tool_invocations_cache_source",
      sql`(${t.dataOrigin} = 'CACHE') = (${t.cacheSourceInvocationId} IS NOT NULL)`,
    ),
    check("tool_invocations_attempt", sql`${t.attempt} >= 1`),
  ],
);

// 4.4
export const culturalEntities = pgTable(
  "cultural_entities",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: entityKind("kind").notNull(),
    qlooId: text("qloo_id").notNull(),
    qlooType: text("qloo_type"),
    domain: text("domain"),
    name: text("name").notNull(),
    disambiguation: text("disambiguation"),
    legacyType: boolean("legacy_type").notNull().default(false),
    snapshot: jsonb("snapshot").notNull(),
    sourceToolInvocationId: uuid("source_tool_invocation_id").references(
      () => toolInvocations.id,
      { onDelete: "set null" },
    ),
    provenanceClass: provenanceClass("provenance_class").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cultural_entities_qloo_uq").on(
      t.workspaceId,
      t.kind,
      t.qlooId,
    ),
    index("cultural_entities_domain_idx").on(t.workspaceId, t.domain),
    check(
      "cultural_entities_provenance",
      sql`${t.provenanceClass} IN ('QLOO_SOURCED','DEVELOPMENT_FIXTURE')`,
    ),
  ],
);

// 4.5
export const entityResolutionRecords = pgTable(
  "entity_resolution_records",
  {
    id: uuid("id").primaryKey(),
    briefVersionId: uuid("brief_version_id").references(
      () => briefVersions.id,
      { onDelete: "cascade" },
    ),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    interestIndex: integer("interest_index"),
    inputText: text("input_text").notNull(),
    domainHint: text("domain_hint"),
    requestedKind: entityKind("requested_kind").notNull().default("entity"),
    // ResolutionCandidates: all candidates, harness alternatives, tag candidates, provenance.
    candidates: jsonb("candidates")
      .notNull()
      .default(sql`'{"entities":[],"tags":[],"provenance":[]}'::jsonb`),
    status: resolutionStatus("status").notNull(),
    method: resolutionMethod("method"),
    selectedEntityId: uuid("selected_entity_id").references(
      () => culturalEntities.id,
    ),
    toolInvocationIds: uuid("tool_invocation_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("resolutions_brief_idx").on(t.briefVersionId, t.interestIndex),
    index("resolutions_project_idx").on(t.projectId, t.createdAt.desc()),
    check(
      "resolutions_input_len",
      sql`char_length(${t.inputText}) BETWEEN 1 AND 120`,
    ),
    check(
      "resolutions_resolved_selection",
      sql`(${t.status} <> 'RESOLVED') OR (${t.selectedEntityId} IS NOT NULL AND ${t.method} IS NOT NULL)`,
    ),
  ],
);

// 4.7
export const experimentSeeds = pgTable(
  "experiment_seeds",
  {
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => culturalEntities.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    ordinal: smallint("ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.experimentId, t.entityId, t.role] }),
    check(
      "experiment_seeds_role",
      sql`${t.role} IN ('seed','tag_constraint','location')`,
    ),
  ],
);

// 4.8
export const counterfactualBranches = pgTable(
  "counterfactual_branches",
  {
    id: uuid("id").primaryKey(),
    parentExperimentId: uuid("parent_experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "restrict" }),
    branchExperimentId: uuid("branch_experiment_id")
      .notNull()
      .unique()
      .references(() => experiments.id, { onDelete: "cascade" }),
    variableDelta: jsonb("variable_delta").notNull(),
    mode: text("mode").notNull(),
    plannedDirtyQueries: integer("planned_dirty_queries").notNull(),
    plannedReusedQueries: integer("planned_reused_queries").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("branches_parent_idx").on(t.parentExperimentId, t.createdAt.desc()),
    check("branches_mode", sql`${t.mode} IN ('hold_hypotheses','regenerate')`),
    check(
      "branches_counts",
      sql`${t.plannedDirtyQueries} >= 0 AND ${t.plannedReusedQueries} >= 0`,
    ),
  ],
);

// 4.10
export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    state: runState("state").notNull(),
    role: agentRole("role"),
    summary: text("summary").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check(
      "run_events_summary_len",
      sql`char_length(${t.summary}) BETWEEN 1 AND 280`,
    ),
    check("run_events_seq", sql`${t.seq} >= 1`),
  ],
);

// 4.14
export const collisionCandidates = pgTable(
  "collision_candidates",
  {
    id: uuid("id").primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    elementEntityIds: uuid("element_entity_ids").array().notNull(),
    bridgeRelationIds: uuid("bridge_relation_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    relevance: real("relevance").notNull(),
    novelty: real("novelty").notNull(),
    tensionFit: real("tension_fit").notNull(),
    noveltyInputs: text("novelty_inputs").notNull(),
    selected: boolean("selected").notNull(),
    rank: smallint("rank"),
  },
  (t) => [
    index("collision_candidates_idx").on(t.experimentId, t.selected, t.rank),
    check(
      "collision_candidates_cardinality",
      sql`cardinality(${t.elementEntityIds}) BETWEEN 2 AND 3`,
    ),
    check(
      "collision_candidates_scores",
      sql`${t.relevance} BETWEEN 0 AND 1 AND ${t.novelty} BETWEEN 0 AND 1 AND ${t.tensionFit} BETWEEN 0 AND 1`,
    ),
    check(
      "collision_candidates_inputs",
      sql`${t.noveltyInputs} IN ('FULL','REDUCED_INPUTS')`,
    ),
  ],
);

// 4.15
export const entityRelations = pgTable(
  "entity_relations",
  {
    id: uuid("id").primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => culturalEntities.id),
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => culturalEntities.id),
    kind: relationKind("kind").notNull(),
    provenanceClass: provenanceClass("provenance_class").notNull(),
    toolInvocationIds: uuid("tool_invocation_ids").array().notNull(),
    facts: jsonb("facts").notNull(),
    weight: real("weight"),
  },
  (t) => [
    index("entity_relations_kind_idx").on(t.experimentId, t.kind),
    index("entity_relations_from_idx").on(t.fromEntityId),
    index("entity_relations_to_idx").on(t.toEntityId),
    check(
      "entity_relations_distinct",
      sql`${t.fromEntityId} <> ${t.toEntityId}`,
    ),
    check(
      "entity_relations_invocations",
      sql`cardinality(${t.toolInvocationIds}) >= 1`,
    ),
  ],
);

// 4.16. Scores are app-derived. support_score summarizes evidence of AUDIENCE AFFINITY only;
// there is deliberately no Qloo-derived creative-suitability score (ADR-019).
export const hypotheses = pgTable(
  "hypotheses",
  {
    id: uuid("id").primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id),
    collisionCandidateId: uuid("collision_candidate_id").references(
      () => collisionCandidates.id,
    ),
    lineageId: uuid("lineage_id").notNull(),
    revisionOfId: uuid("revision_of_id").references(
      (): AnyPgColumn => hypotheses.id,
    ),
    inheritedFromId: uuid("inherited_from_id").references(
      (): AnyPgColumn => hypotheses.id,
    ),
    iteration: smallint("iteration").notNull(),
    title: text("title").notNull(),
    premise: text("premise").notNull(),
    experienceSketch: text("experience_sketch").notNull(),
    creativeElements: jsonb("creative_elements")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: hypothesisStatus("status").notNull(),
    supportScore: real("support_score"),
    noveltyScore: real("novelty_score"),
    feasibilityScore: real("feasibility_score"),
    compositeScore: real("composite_score"),
    scoreBreakdown: jsonb("score_breakdown"),
    scoringVersion: text("scoring_version").notNull(),
    retired: boolean("retired").notNull().default(false),
    userPinned: boolean("user_pinned").notNull().default(false),
    userNote: text("user_note"),
    llmInvocationId: uuid("llm_invocation_id")
      .notNull()
      .references(() => llmInvocations.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("hypotheses_experiment_idx").on(
      t.experimentId,
      t.retired,
      t.compositeScore.desc(),
    ),
    index("hypotheses_lineage_idx").on(t.lineageId, t.iteration),
    check(
      "hypotheses_title_len",
      sql`char_length(${t.title}) BETWEEN 1 AND 80`,
    ),
    check("hypotheses_premise_len", sql`char_length(${t.premise}) <= 400`),
    check(
      "hypotheses_sketch_len",
      sql`char_length(${t.experienceSketch}) <= 600`,
    ),
    check(
      "hypotheses_note_len",
      sql`${t.userNote} IS NULL OR char_length(${t.userNote}) <= 500`,
    ),
    check(
      "hypotheses_score_range",
      sql`(${t.supportScore} IS NULL OR ${t.supportScore} BETWEEN 0 AND 100) AND (${t.noveltyScore} IS NULL OR ${t.noveltyScore} BETWEEN 0 AND 100) AND (${t.feasibilityScore} IS NULL OR ${t.feasibilityScore} BETWEEN 0 AND 100) AND (${t.compositeScore} IS NULL OR ${t.compositeScore} BETWEEN 0 AND 100)`,
    ),
  ],
);

// 4.17
export const hypothesisElements = pgTable(
  "hypothesis_elements",
  {
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => culturalEntities.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hypothesisId, t.entityId] }),
    check(
      "hypothesis_elements_role",
      sql`${t.role} IN ('anchor','accent','context')`,
    ),
  ],
);

// 4.18
export const hypothesisClaims = pgTable(
  "hypothesis_claims",
  {
    id: uuid("id").primaryKey(),
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id, { onDelete: "cascade" }),
    ordinal: smallint("ordinal").notNull(),
    statement: text("statement").notNull(),
    testKind: claimTestKind("test_kind").notNull(),
    testParams: jsonb("test_params").notNull(),
    status: claimStatus("status").notNull(),
    currentStance: evidenceStance("current_stance"),
    dependsOn: text("depends_on")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    queryRequestHash: hash64("query_request_hash"),
  },
  (t) => [
    index("claims_hypothesis_idx").on(t.hypothesisId, t.ordinal),
    index("claims_request_idx").on(t.queryRequestHash),
    check(
      "claims_statement_len",
      sql`char_length(${t.statement}) BETWEEN 1 AND 200`,
    ),
  ],
);

// 4.19. The traceability core: one stance per row, linked to a claim and its invocation.
export const evidenceRecords = pgTable(
  "evidence_records",
  {
    id: uuid("id").primaryKey(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => hypothesisClaims.id, { onDelete: "cascade" }),
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id),
    toolInvocationId: uuid("tool_invocation_id").references(
      () => toolInvocations.id,
      { onDelete: "restrict" },
    ),
    stance: evidenceStance("stance").notNull(),
    evaluatorId: text("evaluator_id").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    facts: jsonb("facts").notNull(),
    primaryMeasure: qlooMeasure("primary_measure").notNull(),
    quality: evidenceQuality("quality").notNull(),
    provenanceClass: provenanceClass("provenance_class").notNull(),
    criticNote: text("critic_note"),
    criticDowngrade: boolean("critic_downgrade").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_hypothesis_idx").on(t.hypothesisId),
    index("evidence_claim_idx").on(t.claimId, t.createdAt.desc()),
    index("evidence_experiment_idx").on(t.experimentId, t.stance),
    index("evidence_invocation_idx").on(t.toolInvocationId),
    check(
      "evidence_qloo_needs_invocation",
      sql`${t.provenanceClass} <> 'QLOO_SOURCED' OR ${t.toolInvocationId} IS NOT NULL`,
    ),
    check(
      "evidence_never_model_sourced",
      sql`${t.provenanceClass} IN ('QLOO_SOURCED','APP_DERIVED','DEVELOPMENT_FIXTURE')`,
    ),
    check(
      "evidence_critic_note_len",
      sql`${t.criticNote} IS NULL OR char_length(${t.criticNote}) <= 400`,
    ),
  ],
);

// 4.20
export const experimentComparisons = pgTable(
  "experiment_comparisons",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    baseExperimentId: uuid("base_experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    otherExperimentId: uuid("other_experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    comparisonKind: comparisonKind("comparison_kind").notNull(),
    metrics: jsonb("metrics").notNull(),
    dirtyQueries: integer("dirty_queries").notNull(),
    reusedQueries: integer("reused_queries").notNull(),
    newQlooResults: integer("new_qloo_results").notNull(),
    narrative: jsonb("narrative"),
    metricsVersion: text("metrics_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("comparisons_uq").on(
      t.baseExperimentId,
      t.otherExperimentId,
      t.metricsVersion,
    ),
    check(
      "comparisons_distinct",
      sql`${t.baseExperimentId} <> ${t.otherExperimentId}`,
    ),
  ],
);

// 4.21 (current_revision_id FK added as DEFERRABLE in the custom migration)
export const experienceBlueprints = pgTable(
  "experience_blueprints",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "restrict" }),
    hypothesisIds: uuid("hypothesis_ids").array().notNull(),
    format: blueprintFormat("format").notNull(),
    status: blueprintStatus("status").notNull().default("DRAFT"),
    currentRevisionId: uuid("current_revision_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("blueprints_project_idx").on(t.projectId, t.updatedAt.desc()),
    check(
      "blueprints_hypotheses",
      sql`cardinality(${t.hypothesisIds}) BETWEEN 1 AND 3`,
    ),
  ],
);

// 4.22
export const blueprintRevisions = pgTable(
  "blueprint_revisions",
  {
    id: uuid("id").primaryKey(),
    blueprintId: uuid("blueprint_id")
      .notNull()
      .references(() => experienceBlueprints.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => blueprintRevisions.id,
    ),
    author: revisionAuthor("author").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id),
    content: jsonb("content").notNull(),
    contentHash: hash64("content_hash").notNull(),
    traceabilityReport: jsonb("traceability_report").notNull(),
    changeSummary: text("change_summary"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("blueprint_revisions_uq").on(t.blueprintId, t.revisionNumber),
    check(
      "blueprint_revisions_agent_run",
      sql`${t.author} <> 'AGENT' OR ${t.runId} IS NOT NULL`,
    ),
    check(
      "blueprint_revisions_summary_len",
      sql`${t.changeSummary} IS NULL OR char_length(${t.changeSummary}) <= 280`,
    ),
  ],
);

// 4.23
export const graphLayouts = pgTable("graph_layouts", {
  experimentId: uuid("experiment_id")
    .primaryKey()
    .references(() => experiments.id, { onDelete: "cascade" }),
  positions: jsonb("positions").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// 4.24
export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: shareScope("scope").notNull(),
    targetId: uuid("target_id").notNull(),
    tokenHash: hash64("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
  },
  (t) => [index("share_links_project_idx").on(t.projectId)],
);

// 4.25 operational tables
export const usageCounters = pgTable(
  "usage_counters",
  {
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    metric: text("metric").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.scopeId, t.metric, t.day] }),
    check("usage_counters_scope", sql`${t.scope} IN ('global','workspace')`),
    check("usage_counters_day", sql`${t.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull(),
  qlooReady: boolean("qloo_ready").notNull().default(false),
  harnessVersion: text("harness_version"),
  transport: text("transport"),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: uuid("key").notNull(),
    requestHash: hash64("request_hash").notNull(),
    response: jsonb("response").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const promptTemplates = pgTable(
  "prompt_templates",
  {
    promptId: text("prompt_id").notNull(),
    version: text("version").notNull(),
    contentHash: hash64("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.version] })],
);
