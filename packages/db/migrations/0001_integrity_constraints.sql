-- Integrity rules that the Drizzle schema builder cannot express (DATABASE_SCHEMA.md §4, §5, §8).

-- Circular "current pointer" references are DEFERRABLE so a version and its pointer can be
-- written in one transaction in either order.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_current_brief_version_fk"
  FOREIGN KEY ("current_brief_version_id") REFERENCES "brief_versions"("id")
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "experience_blueprints"
  ADD CONSTRAINT "blueprints_current_revision_fk"
  FOREIGN KEY ("current_revision_id") REFERENCES "blueprint_revisions"("id")
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_blueprint_fk"
  FOREIGN KEY ("blueprint_id") REFERENCES "experience_blueprints"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Append-only tables: rows are immutable once written. Deletes (retention, cascades) remain allowed.
CREATE OR REPLACE FUNCTION tl_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: UPDATE is not allowed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_events_append_only BEFORE UPDATE ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION tl_forbid_update();
--> statement-breakpoint
CREATE TRIGGER evidence_records_append_only BEFORE UPDATE ON "evidence_records"
  FOR EACH ROW EXECUTE FUNCTION tl_forbid_update();
--> statement-breakpoint
CREATE TRIGGER tool_invocations_append_only BEFORE UPDATE ON "tool_invocations"
  FOR EACH ROW EXECUTE FUNCTION tl_forbid_update();
--> statement-breakpoint
CREATE TRIGGER blueprint_revisions_append_only BEFORE UPDATE ON "blueprint_revisions"
  FOR EACH ROW EXECUTE FUNCTION tl_forbid_update();
--> statement-breakpoint

-- Snapshots: only retention bookkeeping (pinned, expires_at) may change; the recorded response
-- metadata and any retained raw payload are immutable.
CREATE OR REPLACE FUNCTION tl_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.request_hash, NEW.workflow, NEW.transport, NEW.harness_version, NEW.envelope_status,
      NEW.envelope_shape, NEW.result_count, NEW.raw_retained, NEW.raw, NEW.raw_bytes,
      NEW.is_fixture, NEW.retrieved_at)
     IS DISTINCT FROM
     (OLD.request_hash, OLD.workflow, OLD.transport, OLD.harness_version, OLD.envelope_status,
      OLD.envelope_shape, OLD.result_count, OLD.raw_retained, OLD.raw, OLD.raw_bytes,
      OLD.is_fixture, OLD.retrieved_at) THEN
    RAISE EXCEPTION 'qloo_response_snapshots: only pinned and expires_at may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER qloo_response_snapshots_guard BEFORE UPDATE ON "qloo_response_snapshots"
  FOR EACH ROW EXECUTE FUNCTION tl_snapshot_guard();
--> statement-breakpoint

-- Fixture firewall (ADR-014): evidence derived from a FIXTURE invocation must be labelled
-- DEVELOPMENT_FIXTURE, and DEVELOPMENT_FIXTURE evidence must come from a FIXTURE invocation.
CREATE OR REPLACE FUNCTION tl_evidence_fixture_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origin data_origin;
BEGIN
  IF NEW.tool_invocation_id IS NOT NULL THEN
    SELECT data_origin INTO origin FROM tool_invocations WHERE id = NEW.tool_invocation_id;
  END IF;
  IF origin = 'FIXTURE' AND NEW.provenance_class <> 'DEVELOPMENT_FIXTURE' THEN
    RAISE EXCEPTION 'evidence from a FIXTURE invocation must be DEVELOPMENT_FIXTURE'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provenance_class = 'DEVELOPMENT_FIXTURE' AND origin IS DISTINCT FROM 'FIXTURE' THEN
    RAISE EXCEPTION 'DEVELOPMENT_FIXTURE evidence requires a FIXTURE invocation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_records_fixture_coupling BEFORE INSERT ON "evidence_records"
  FOR EACH ROW EXECUTE FUNCTION tl_evidence_fixture_coupling();
--> statement-breakpoint

-- The same rule for entities: a fixture-sourced entity can never be labelled QLOO_SOURCED.
CREATE OR REPLACE FUNCTION tl_entity_fixture_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origin data_origin;
BEGIN
  IF NEW.source_tool_invocation_id IS NOT NULL THEN
    SELECT data_origin INTO origin FROM tool_invocations WHERE id = NEW.source_tool_invocation_id;
    IF origin = 'FIXTURE' AND NEW.provenance_class <> 'DEVELOPMENT_FIXTURE' THEN
      RAISE EXCEPTION 'entities from a FIXTURE invocation must be DEVELOPMENT_FIXTURE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cultural_entities_fixture_coupling BEFORE INSERT OR UPDATE ON "cultural_entities"
  FOR EACH ROW EXECUTE FUNCTION tl_entity_fixture_coupling();
