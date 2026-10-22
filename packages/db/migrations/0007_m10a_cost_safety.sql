CREATE TABLE "demo_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"code_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"max_runs" integer NOT NULL,
	"max_llm_usd_micros" bigint NOT NULL,
	CONSTRAINT "demo_access_grants_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "demo_access_grants_max_runs" CHECK ("demo_access_grants"."max_runs" >= 0),
	CONSTRAINT "demo_access_grants_max_usd" CHECK ("demo_access_grants"."max_llm_usd_micros" >= 0),
	CONSTRAINT "demo_access_grants_label" CHECK (length("demo_access_grants"."label") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "llm_spend_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"grant_id" uuid,
	"model" text NOT NULL,
	"day" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"actual_micros" bigint,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "llm_spend_reservations_status" CHECK ("llm_spend_reservations"."status" IN ('RESERVED','SETTLED','UNKNOWN')),
	CONSTRAINT "llm_spend_reservations_amounts" CHECK ("llm_spend_reservations"."reserved_micros" >= 0 AND ("llm_spend_reservations"."actual_micros" IS NULL OR "llm_spend_reservations"."actual_micros" >= 0))
);
--> statement-breakpoint
ALTER TABLE "usage_counters" DROP CONSTRAINT "usage_counters_scope";--> statement-breakpoint
ALTER TABLE "usage_counters" DROP CONSTRAINT "usage_counters_day";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "demo_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_spend_reservations" ADD CONSTRAINT "llm_spend_reservations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_spend_reservations_run_idx" ON "llm_spend_reservations" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_demo_grant_id_demo_access_grants_id_fk" FOREIGN KEY ("demo_grant_id") REFERENCES "public"."demo_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_scope" CHECK ("usage_counters"."scope" IN ('global','workspace','experiment','run','grant'));--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_day" CHECK ("usage_counters"."day" ~ '^\d{4}-\d{2}-\d{2}$' OR "usage_counters"."day" = 'total');