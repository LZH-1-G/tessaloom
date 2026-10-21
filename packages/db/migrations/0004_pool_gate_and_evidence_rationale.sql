ALTER TYPE "public"."run_state" ADD VALUE 'AWAITING_POOL_CONFIRMATION' BEFORE 'GENERATING_HYPOTHESES';--> statement-breakpoint
ALTER TABLE "evidence_records" ADD COLUMN "rationale" text;