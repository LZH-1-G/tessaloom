-- Fixture firewall (ADR-014, ADR-024): a CACHE invocation inherits the data origin of the
-- invocation it was served from, so cached fixture data can never pass as Qloo data.
CREATE OR REPLACE FUNCTION tl_effective_origin(invocation uuid) RETURNS data_origin
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t.data_origin = 'CACHE' THEN coalesce(s.data_origin, t.data_origin) ELSE t.data_origin END
  FROM tool_invocations t
  LEFT JOIN tool_invocations s ON s.id = t.cache_source_invocation_id
  WHERE t.id = invocation
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tl_evidence_fixture_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origin data_origin;
BEGIN
  IF NEW.tool_invocation_id IS NOT NULL THEN
    origin := tl_effective_origin(NEW.tool_invocation_id);
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
CREATE OR REPLACE FUNCTION tl_entity_fixture_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origin data_origin;
BEGIN
  IF NEW.source_tool_invocation_id IS NOT NULL THEN
    origin := tl_effective_origin(NEW.source_tool_invocation_id);
    IF origin = 'FIXTURE' AND NEW.provenance_class <> 'DEVELOPMENT_FIXTURE' THEN
      RAISE EXCEPTION 'entities from a FIXTURE invocation must be DEVELOPMENT_FIXTURE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
