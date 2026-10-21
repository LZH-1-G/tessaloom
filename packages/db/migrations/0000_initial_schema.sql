CREATE TYPE "public"."agent_role" AS ENUM('R1', 'R2', 'R3', 'R4', 'R5', 'R6');--> statement-breakpoint
CREATE TYPE "public"."blueprint_format" AS ENUM('event', 'series', 'installation');--> statement-breakpoint
CREATE TYPE "public"."blueprint_status" AS ENUM('DRAFT', 'ACCEPTED');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('PLANNED', 'TESTED', 'UNTESTED_BUDGET', 'UNSUPPORTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."claim_test_kind" AS ENUM('CROSS_DOMAIN_AFFINITY', 'SHORTLIST_FIT', 'AUDIENCE_BRIDGE', 'TAG_RESONANCE', 'LOCATION_FIT', 'MOMENTUM', 'AUDIENCE_PROFILE');--> statement-breakpoint
CREATE TYPE "public"."comparison_kind" AS ENUM('COUNTERFACTUAL', 'DATA_DRIFT', 'AD_HOC');--> statement-breakpoint
CREATE TYPE "public"."data_origin" AS ENUM('LIVE', 'CACHE', 'REPLAY', 'FIXTURE');--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('entity', 'tag', 'locality');--> statement-breakpoint
CREATE TYPE "public"."envelope_shape" AS ENUM('search_array', 'result_list', 'compare_object', 'series', 'needs_input', 'error_object', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."envelope_status" AS ENUM('ok', 'empty', 'needs_input', 'partial', 'degraded', 'error', 'transport_error');--> statement-breakpoint
CREATE TYPE "public"."evidence_quality" AS ENUM('FULL', 'PARTIAL', 'DEGRADED', 'FIELD_UNAVAILABLE', 'UNSUPPORTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."evidence_stance" AS ENUM('SUPPORTS', 'CONTRADICTS', 'NEUTRAL', 'INSUFFICIENT');--> statement-breakpoint
CREATE TYPE "public"."experiment_kind" AS ENUM('ROOT', 'BRANCH');--> statement-breakpoint
CREATE TYPE "public"."experiment_mode" AS ENUM('live', 'replay', 'fixture');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_LIMITS', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."hypothesis_status" AS ENUM('SPECULATIVE', 'UNDER_INVESTIGATION', 'SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONTRADICTED', 'INCONCLUSIVE', 'UNTESTABLE');--> statement-breakpoint
CREATE TYPE "public"."llm_validation_status" AS ENUM('VALID', 'REPAIRED', 'INVALID', 'REFUSED', 'TRUNCATED');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."provenance_class" AS ENUM('QLOO_SOURCED', 'APP_DERIVED', 'MODEL_INTERPRETATION', 'CREATIVE_SPECULATION', 'USER_PROVIDED', 'DEVELOPMENT_FIXTURE');--> statement-breakpoint
CREATE TYPE "public"."qloo_measure" AS ENUM('AUDIENCE_AFFINITY', 'POPULARITY', 'RANK_POSITION', 'AUDIENCE_TAG_OVERLAP', 'GEO_AFFINITY', 'TREND', 'DEMOGRAPHIC_INDEX', 'TAG_ASSOCIATION', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."qloo_transport" AS ENUM('HARNESS_MCP', 'HARNESS_CLI', 'FIXTURE');--> statement-breakpoint
CREATE TYPE "public"."relation_kind" AS ENUM('THREAD', 'BRIDGE_SHARED_TAG', 'BRIDGE_CO_OCCURRENCE', 'HAS_TAG', 'POPULAR_IN');--> statement-breakpoint
CREATE TYPE "public"."resolution_method" AS ENUM('EXACT_SINGLE', 'USER_SELECTED', 'USER_REFINED', 'SAMPLE_PRESET');--> statement-breakpoint
CREATE TYPE "public"."resolution_status" AS ENUM('PENDING', 'RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'EXCLUDED');--> statement-breakpoint
CREATE TYPE "public"."revision_author" AS ENUM('AGENT', 'USER');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('EXPLORATION', 'COUNTERFACTUAL', 'COMPOSITION', 'REVALIDATION');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('QUEUED', 'ANALYZING_INTENT', 'AWAITING_BRIEF_CONFIRMATION', 'RESOLVING_ENTITIES', 'AWAITING_ENTITY_CONFIRMATION', 'DISCOVERING', 'BUILDING_COLLISION_POOL', 'GENERATING_HYPOTHESES', 'PLANNING_EVIDENCE', 'COLLECTING_EVIDENCE', 'EVALUATING_EVIDENCE', 'REVISING_HYPOTHESES', 'AWAITING_HYPOTHESIS_SELECTION', 'PLANNING_COUNTERFACTUAL', 'AWAITING_COUNTERFACTUAL_CONFIRMATION', 'COMPARING', 'COMPOSING_BLUEPRINT', 'VALIDATING_BLUEPRINT', 'COMPLETED', 'COMPLETED_WITH_LIMITS', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."share_scope" AS ENUM('project', 'experiment', 'blueprint');--> statement-breakpoint
CREATE TYPE "public"."use_case" AS ENUM('bookstore', 'cafe', 'venue', 'community_event', 'other');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('anonymous', 'system');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"blueprint_id" uuid,
	"kind" "run_kind" NOT NULL,
	"state" "run_state" DEFAULT 'QUEUED' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"iteration" smallint DEFAULT 0 NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"pending_confirmation" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"terminal_reason" text,
	"error" jsonb,
	"trace_id" char(32) NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_iteration" CHECK ("agent_runs"."iteration" BETWEEN 0 AND 10),
	CONSTRAINT "agent_runs_state_version" CHECK ("agent_runs"."state_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blueprint_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"parent_revision_id" uuid,
	"author" "revision_author" NOT NULL,
	"run_id" uuid,
	"content" jsonb NOT NULL,
	"content_hash" char(64) NOT NULL,
	"traceability_report" jsonb NOT NULL,
	"change_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_revisions_agent_run" CHECK ("blueprint_revisions"."author" <> 'AGENT' OR "blueprint_revisions"."run_id" IS NOT NULL),
	CONSTRAINT "blueprint_revisions_summary_len" CHECK ("blueprint_revisions"."change_summary" IS NULL OR char_length("blueprint_revisions"."change_summary") <= 280)
);
--> statement-breakpoint
CREATE TABLE "brief_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" char(64) NOT NULL,
	"intent_frame" jsonb,
	"intent_llm_invocation_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_versions_version_positive" CHECK ("brief_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "collision_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"element_entity_ids" uuid[] NOT NULL,
	"bridge_relation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"relevance" real NOT NULL,
	"novelty" real NOT NULL,
	"tension_fit" real NOT NULL,
	"novelty_inputs" text NOT NULL,
	"selected" boolean NOT NULL,
	"rank" smallint,
	CONSTRAINT "collision_candidates_cardinality" CHECK (cardinality("collision_candidates"."element_entity_ids") BETWEEN 2 AND 3),
	CONSTRAINT "collision_candidates_scores" CHECK ("collision_candidates"."relevance" BETWEEN 0 AND 1 AND "collision_candidates"."novelty" BETWEEN 0 AND 1 AND "collision_candidates"."tension_fit" BETWEEN 0 AND 1),
	CONSTRAINT "collision_candidates_inputs" CHECK ("collision_candidates"."novelty_inputs" IN ('FULL','REDUCED_INPUTS'))
);
--> statement-breakpoint
CREATE TABLE "counterfactual_branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_experiment_id" uuid NOT NULL,
	"branch_experiment_id" uuid NOT NULL,
	"variable_delta" jsonb NOT NULL,
	"mode" text NOT NULL,
	"planned_dirty_queries" integer NOT NULL,
	"planned_reused_queries" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterfactual_branches_branch_experiment_id_unique" UNIQUE("branch_experiment_id"),
	CONSTRAINT "branches_mode" CHECK ("counterfactual_branches"."mode" IN ('hold_hypotheses','regenerate')),
	CONSTRAINT "branches_counts" CHECK ("counterfactual_branches"."planned_dirty_queries" >= 0 AND "counterfactual_branches"."planned_reused_queries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cultural_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "entity_kind" NOT NULL,
	"qloo_id" text NOT NULL,
	"qloo_type" text,
	"domain" text,
	"name" text NOT NULL,
	"disambiguation" text,
	"legacy_type" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source_tool_invocation_id" uuid,
	"provenance_class" "provenance_class" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cultural_entities_provenance" CHECK ("cultural_entities"."provenance_class" IN ('QLOO_SOURCED','DEVELOPMENT_FIXTURE'))
);
--> statement-breakpoint
CREATE TABLE "entity_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"kind" "relation_kind" NOT NULL,
	"provenance_class" "provenance_class" NOT NULL,
	"tool_invocation_ids" uuid[] NOT NULL,
	"facts" jsonb NOT NULL,
	"weight" real,
	CONSTRAINT "entity_relations_distinct" CHECK ("entity_relations"."from_entity_id" <> "entity_relations"."to_entity_id"),
	CONSTRAINT "entity_relations_invocations" CHECK (cardinality("entity_relations"."tool_invocation_ids") >= 1)
);
--> statement-breakpoint
CREATE TABLE "entity_resolution_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"brief_version_id" uuid,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"interest_index" integer,
	"input_text" text NOT NULL,
	"domain_hint" text,
	"requested_kind" "entity_kind" DEFAULT 'entity' NOT NULL,
	"candidates" jsonb DEFAULT '{"entities":[],"tags":[],"provenance":[]}'::jsonb NOT NULL,
	"status" "resolution_status" NOT NULL,
	"method" "resolution_method",
	"selected_entity_id" uuid,
	"tool_invocation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolutions_input_len" CHECK (char_length("entity_resolution_records"."input_text") BETWEEN 1 AND 120),
	CONSTRAINT "resolutions_resolved_selection" CHECK (("entity_resolution_records"."status" <> 'RESOLVED') OR ("entity_resolution_records"."selected_entity_id" IS NOT NULL AND "entity_resolution_records"."method" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_invocation_id" uuid,
	"stance" "evidence_stance" NOT NULL,
	"evaluator_id" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"facts" jsonb NOT NULL,
	"primary_measure" "qloo_measure" NOT NULL,
	"quality" "evidence_quality" NOT NULL,
	"provenance_class" "provenance_class" NOT NULL,
	"critic_note" text,
	"critic_downgrade" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_qloo_needs_invocation" CHECK ("evidence_records"."provenance_class" <> 'QLOO_SOURCED' OR "evidence_records"."tool_invocation_id" IS NOT NULL),
	CONSTRAINT "evidence_never_model_sourced" CHECK ("evidence_records"."provenance_class" IN ('QLOO_SOURCED','APP_DERIVED','DEVELOPMENT_FIXTURE')),
	CONSTRAINT "evidence_critic_note_len" CHECK ("evidence_records"."critic_note" IS NULL OR char_length("evidence_records"."critic_note") <= 400)
);
--> statement-breakpoint
CREATE TABLE "experience_blueprints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"hypothesis_ids" uuid[] NOT NULL,
	"format" "blueprint_format" NOT NULL,
	"status" "blueprint_status" DEFAULT 'DRAFT' NOT NULL,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blueprints_hypotheses" CHECK (cardinality("experience_blueprints"."hypothesis_ids") BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "experiment_comparisons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"base_experiment_id" uuid NOT NULL,
	"other_experiment_id" uuid NOT NULL,
	"comparison_kind" "comparison_kind" NOT NULL,
	"metrics" jsonb NOT NULL,
	"dirty_queries" integer NOT NULL,
	"reused_queries" integer NOT NULL,
	"new_qloo_results" integer NOT NULL,
	"narrative" jsonb,
	"metrics_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comparisons_distinct" CHECK ("experiment_comparisons"."base_experiment_id" <> "experiment_comparisons"."other_experiment_id")
);
--> statement-breakpoint
CREATE TABLE "experiment_seeds" (
	"experiment_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text NOT NULL,
	"ordinal" smallint NOT NULL,
	CONSTRAINT "experiment_seeds_experiment_id_entity_id_role_pk" PRIMARY KEY("experiment_id","entity_id","role"),
	CONSTRAINT "experiment_seeds_role" CHECK ("experiment_seeds"."role" IN ('seed','tag_constraint','location'))
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"brief_version_id" uuid NOT NULL,
	"kind" "experiment_kind" NOT NULL,
	"parent_experiment_id" uuid,
	"root_experiment_id" uuid,
	"experiment_key" char(64) NOT NULL,
	"definition" jsonb NOT NULL,
	"label" text,
	"status" "experiment_status" DEFAULT 'PENDING' NOT NULL,
	"mode" "experiment_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "experiments_branch_parent" CHECK (("experiments"."kind" = 'BRANCH') = ("experiments"."parent_experiment_id" IS NOT NULL)),
	CONSTRAINT "experiments_label_len" CHECK ("experiments"."label" IS NULL OR char_length("experiments"."label") <= 80)
);
--> statement-breakpoint
CREATE TABLE "graph_layouts" (
	"experiment_id" uuid PRIMARY KEY NOT NULL,
	"positions" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"collision_candidate_id" uuid,
	"lineage_id" uuid NOT NULL,
	"revision_of_id" uuid,
	"inherited_from_id" uuid,
	"iteration" smallint NOT NULL,
	"title" text NOT NULL,
	"premise" text NOT NULL,
	"experience_sketch" text NOT NULL,
	"creative_elements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "hypothesis_status" NOT NULL,
	"support_score" real,
	"novelty_score" real,
	"feasibility_score" real,
	"composite_score" real,
	"score_breakdown" jsonb,
	"scoring_version" text NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"user_pinned" boolean DEFAULT false NOT NULL,
	"user_note" text,
	"llm_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hypotheses_title_len" CHECK (char_length("hypotheses"."title") BETWEEN 1 AND 80),
	CONSTRAINT "hypotheses_premise_len" CHECK (char_length("hypotheses"."premise") <= 400),
	CONSTRAINT "hypotheses_sketch_len" CHECK (char_length("hypotheses"."experience_sketch") <= 600),
	CONSTRAINT "hypotheses_note_len" CHECK ("hypotheses"."user_note" IS NULL OR char_length("hypotheses"."user_note") <= 500),
	CONSTRAINT "hypotheses_score_range" CHECK (("hypotheses"."support_score" IS NULL OR "hypotheses"."support_score" BETWEEN 0 AND 100) AND ("hypotheses"."novelty_score" IS NULL OR "hypotheses"."novelty_score" BETWEEN 0 AND 100) AND ("hypotheses"."feasibility_score" IS NULL OR "hypotheses"."feasibility_score" BETWEEN 0 AND 100) AND ("hypotheses"."composite_score" IS NULL OR "hypotheses"."composite_score" BETWEEN 0 AND 100))
);
--> statement-breakpoint
CREATE TABLE "hypothesis_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hypothesis_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"statement" text NOT NULL,
	"test_kind" "claim_test_kind" NOT NULL,
	"test_params" jsonb NOT NULL,
	"status" "claim_status" NOT NULL,
	"current_stance" "evidence_stance",
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"query_request_hash" char(64),
	CONSTRAINT "claims_statement_len" CHECK (char_length("hypothesis_claims"."statement") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "hypothesis_elements" (
	"hypothesis_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "hypothesis_elements_hypothesis_id_entity_id_pk" PRIMARY KEY("hypothesis_id","entity_id"),
	CONSTRAINT "hypothesis_elements_role" CHECK ("hypothesis_elements"."role" IN ('anchor','accent','context'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "llm_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"project_id" uuid NOT NULL,
	"role" "agent_role" NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"effort" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"input_excerpt" jsonb NOT NULL,
	"output" jsonb,
	"validation_status" "llm_validation_status" NOT NULL,
	"validation_errors" jsonb,
	"repair_of_id" uuid,
	"stop_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"use_case" "use_case" NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"current_brief_version_id" uuid,
	"sample_source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_len" CHECK (char_length("projects"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"prompt_id" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_templates_prompt_id_version_pk" PRIMARY KEY("prompt_id","version")
);
--> statement-breakpoint
CREATE TABLE "qloo_response_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_hash" char(64) NOT NULL,
	"workflow" text NOT NULL,
	"transport" "qloo_transport" NOT NULL,
	"harness_version" text NOT NULL,
	"envelope_status" "envelope_status" NOT NULL,
	"envelope_shape" "envelope_shape" NOT NULL,
	"result_count" integer,
	"raw_retained" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"raw_bytes" integer,
	"is_fixture" boolean NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "snapshots_raw_retention" CHECK ("qloo_response_snapshots"."raw_retained" = ("qloo_response_snapshots"."raw" IS NOT NULL)),
	CONSTRAINT "snapshots_raw_bytes" CHECK ("qloo_response_snapshots"."raw_bytes" IS NULL OR "qloo_response_snapshots"."raw_bytes" <= 2000000)
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"state" "run_state" NOT NULL,
	"role" "agent_role",
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_summary_len" CHECK (char_length("run_events"."summary") BETWEEN 1 AND 280),
	CONSTRAINT "run_events_seq" CHECK ("run_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "share_scope" NOT NULL,
	"target_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"project_id" uuid NOT NULL,
	"step_seq" integer,
	"purpose" text NOT NULL,
	"method" text NOT NULL,
	"workflow" text NOT NULL,
	"transport" "qloo_transport" NOT NULL,
	"args_redacted" jsonb NOT NULL,
	"request_hash" char(64) NOT NULL,
	"snapshot_id" uuid,
	"data_origin" "data_origin" NOT NULL,
	"cache_source_invocation_id" uuid,
	"envelope_status" "envelope_status" NOT NULL,
	"envelope_shape" "envelope_shape" NOT NULL,
	"result_count" integer,
	"error_code" text,
	"correlation_id" text,
	"harness_endpoint" text,
	"harness_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_cache_source" CHECK (("tool_invocations"."data_origin" = 'CACHE') = ("tool_invocations"."cache_source_invocation_id" IS NOT NULL)),
	CONSTRAINT "tool_invocations_attempt" CHECK ("tool_invocations"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"metric" text NOT NULL,
	"day" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_scope_scope_id_metric_day_pk" PRIMARY KEY("scope","scope_id","metric","day"),
	CONSTRAINT "usage_counters_scope" CHECK ("usage_counters"."scope" IN ('global','workspace')),
	CONSTRAINT "usage_counters_day" CHECK ("usage_counters"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"qloo_ready" boolean DEFAULT false NOT NULL,
	"harness_version" text,
	"transport" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" char(64) NOT NULL,
	"kind" "workspace_kind" DEFAULT 'anonymous' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revisions" ADD CONSTRAINT "blueprint_revisions_blueprint_id_experience_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."experience_blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revisions" ADD CONSTRAINT "blueprint_revisions_parent_revision_id_blueprint_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."blueprint_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_revisions" ADD CONSTRAINT "blueprint_revisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_intent_llm_invocation_id_llm_invocations_id_fk" FOREIGN KEY ("intent_llm_invocation_id") REFERENCES "public"."llm_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collision_candidates" ADD CONSTRAINT "collision_candidates_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_branches" ADD CONSTRAINT "counterfactual_branches_parent_experiment_id_experiments_id_fk" FOREIGN KEY ("parent_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterfactual_branches" ADD CONSTRAINT "counterfactual_branches_branch_experiment_id_experiments_id_fk" FOREIGN KEY ("branch_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cultural_entities" ADD CONSTRAINT "cultural_entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cultural_entities" ADD CONSTRAINT "cultural_entities_source_tool_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("source_tool_invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_from_entity_id_cultural_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."cultural_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_to_entity_id_cultural_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."cultural_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_resolution_records" ADD CONSTRAINT "entity_resolution_records_brief_version_id_brief_versions_id_fk" FOREIGN KEY ("brief_version_id") REFERENCES "public"."brief_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_resolution_records" ADD CONSTRAINT "entity_resolution_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_resolution_records" ADD CONSTRAINT "entity_resolution_records_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_resolution_records" ADD CONSTRAINT "entity_resolution_records_selected_entity_id_cultural_entities_id_fk" FOREIGN KEY ("selected_entity_id") REFERENCES "public"."cultural_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_claim_id_hypothesis_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."hypothesis_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_tool_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("tool_invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_blueprints" ADD CONSTRAINT "experience_blueprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_blueprints" ADD CONSTRAINT "experience_blueprints_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_comparisons" ADD CONSTRAINT "experiment_comparisons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_comparisons" ADD CONSTRAINT "experiment_comparisons_base_experiment_id_experiments_id_fk" FOREIGN KEY ("base_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_comparisons" ADD CONSTRAINT "experiment_comparisons_other_experiment_id_experiments_id_fk" FOREIGN KEY ("other_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_seeds" ADD CONSTRAINT "experiment_seeds_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_seeds" ADD CONSTRAINT "experiment_seeds_entity_id_cultural_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."cultural_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_brief_version_id_brief_versions_id_fk" FOREIGN KEY ("brief_version_id") REFERENCES "public"."brief_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_parent_experiment_id_experiments_id_fk" FOREIGN KEY ("parent_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_root_experiment_id_experiments_id_fk" FOREIGN KEY ("root_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_layouts" ADD CONSTRAINT "graph_layouts_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_collision_candidate_id_collision_candidates_id_fk" FOREIGN KEY ("collision_candidate_id") REFERENCES "public"."collision_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_revision_of_id_hypotheses_id_fk" FOREIGN KEY ("revision_of_id") REFERENCES "public"."hypotheses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_inherited_from_id_hypotheses_id_fk" FOREIGN KEY ("inherited_from_id") REFERENCES "public"."hypotheses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_llm_invocation_id_llm_invocations_id_fk" FOREIGN KEY ("llm_invocation_id") REFERENCES "public"."llm_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis_claims" ADD CONSTRAINT "hypothesis_claims_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis_elements" ADD CONSTRAINT "hypothesis_elements_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis_elements" ADD CONSTRAINT "hypothesis_elements_entity_id_cultural_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."cultural_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_repair_of_id_llm_invocations_id_fk" FOREIGN KEY ("repair_of_id") REFERENCES "public"."llm_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_snapshot_id_qloo_response_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."qloo_response_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_cache_source_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("cache_source_invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_experiment_idx" ON "agent_runs" USING btree ("experiment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_active_idx" ON "agent_runs" USING btree ("state") WHERE "agent_runs"."state" NOT IN ('COMPLETED','COMPLETED_WITH_LIMITS','FAILED','CANCELLED');--> statement-breakpoint
CREATE UNIQUE INDEX "blueprint_revisions_uq" ON "blueprint_revisions" USING btree ("blueprint_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_versions_project_version_uq" ON "brief_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "brief_versions_project_idx" ON "brief_versions" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collision_candidates_idx" ON "collision_candidates" USING btree ("experiment_id","selected","rank");--> statement-breakpoint
CREATE INDEX "branches_parent_idx" ON "counterfactual_branches" USING btree ("parent_experiment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "cultural_entities_qloo_uq" ON "cultural_entities" USING btree ("workspace_id","kind","qloo_id");--> statement-breakpoint
CREATE INDEX "cultural_entities_domain_idx" ON "cultural_entities" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "entity_relations_kind_idx" ON "entity_relations" USING btree ("experiment_id","kind");--> statement-breakpoint
CREATE INDEX "entity_relations_from_idx" ON "entity_relations" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relations_to_idx" ON "entity_relations" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "resolutions_brief_idx" ON "entity_resolution_records" USING btree ("brief_version_id","interest_index");--> statement-breakpoint
CREATE INDEX "resolutions_project_idx" ON "entity_resolution_records" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_hypothesis_idx" ON "evidence_records" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "evidence_claim_idx" ON "evidence_records" USING btree ("claim_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_experiment_idx" ON "evidence_records" USING btree ("experiment_id","stance");--> statement-breakpoint
CREATE INDEX "evidence_invocation_idx" ON "evidence_records" USING btree ("tool_invocation_id");--> statement-breakpoint
CREATE INDEX "blueprints_project_idx" ON "experience_blueprints" USING btree ("project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "comparisons_uq" ON "experiment_comparisons" USING btree ("base_experiment_id","other_experiment_id","metrics_version");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_project_key_uq" ON "experiments" USING btree ("project_id","experiment_key");--> statement-breakpoint
CREATE INDEX "experiments_project_idx" ON "experiments" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiments_parent_idx" ON "experiments" USING btree ("parent_experiment_id");--> statement-breakpoint
CREATE INDEX "experiments_root_idx" ON "experiments" USING btree ("root_experiment_id");--> statement-breakpoint
CREATE INDEX "hypotheses_experiment_idx" ON "hypotheses" USING btree ("experiment_id","retired","composite_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hypotheses_lineage_idx" ON "hypotheses" USING btree ("lineage_id","iteration");--> statement-breakpoint
CREATE INDEX "claims_hypothesis_idx" ON "hypothesis_claims" USING btree ("hypothesis_id","ordinal");--> statement-breakpoint
CREATE INDEX "claims_request_idx" ON "hypothesis_claims" USING btree ("query_request_hash");--> statement-breakpoint
CREATE INDEX "llm_invocations_run_idx" ON "llm_invocations" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_invocations_project_idx" ON "llm_invocations" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_request_idx" ON "qloo_response_snapshots" USING btree ("request_hash","retrieved_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_expiry_idx" ON "qloo_response_snapshots" USING btree ("expires_at") WHERE NOT "qloo_response_snapshots"."pinned";--> statement-breakpoint
CREATE INDEX "share_links_project_idx" ON "share_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_idx" ON "tool_invocations" USING btree ("run_id","step_seq");--> statement-breakpoint
CREATE INDEX "tool_invocations_project_idx" ON "tool_invocations" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_invocations_request_idx" ON "tool_invocations" USING btree ("request_hash");--> statement-breakpoint
CREATE INDEX "workspaces_last_seen_idx" ON "workspaces" USING btree ("last_seen_at");