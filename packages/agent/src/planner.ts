// The deterministic planner lives in core (shared with the web process; ADR-027).
export {
  STATE_ALLOWLIST,
  isAllowed,
  planEvidence,
  type EvidencePlanResult,
  type PlanEntity,
  type PlannableClaim,
  type PlannedQuery,
  type QueryMethod,
} from "@tessaloom/core";
