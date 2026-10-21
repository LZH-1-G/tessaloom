import {
  canonicalize,
  type ClaimParams,
  type ClaimTestKind,
} from "@tessaloom/core";
import type { ResolvedParams } from "./evaluators";

/** AGENT_WORKFLOW §8.1 allowlist. */
export const STATE_ALLOWLIST: Record<string, readonly string[]> = {
  RESOLVING_ENTITIES: ["searchEntities", "findTags", "describeEntity"],
  DISCOVERING: ["recommend", "entityTags", "findTags"],
  COLLECTING_EVIDENCE: [
    "recommend",
    "rank",
    "compareAudiences",
    "entityTags",
    "wherePopular",
    "trends",
    "audienceDemographics",
  ],
  COMPOSING_BLUEPRINT: ["wherePopular", "rank"],
};

export function isAllowed(state: string, method: string): boolean {
  return STATE_ALLOWLIST[state]?.includes(method) ?? false;
}

export interface PlanEntity {
  qlooId: string;
  domain: string | null;
  kind: "entity" | "tag" | "locality";
}

export interface PlannableClaim {
  claimId: string;
  hypothesisId: string;
  testKind: ClaimTestKind;
  params: ClaimParams;
  /** Composite score of the hypothesis (prioritization); null = not yet scored. */
  priority: number | null;
  ordinal: number;
}

export type QueryMethod =
  | "recommend"
  | "rank"
  | "compareAudiences"
  | "entityTags"
  | "wherePopular"
  | "trends"
  | "audienceDemographics";

export interface PlannedQuery {
  key: string; // canonical method+input; identical queries are executed once
  method: QueryMethod;
  input: Record<string, unknown>;
  claimIds: string[];
}

export interface EvidencePlanResult {
  queries: PlannedQuery[];
  resolved: Map<string, ResolvedParams>; // claimId → params with Qloo IDs
  untestedBudget: string[]; // claimIds trimmed by the budget
  unsupported: { claimId: string; reason: string }[];
}

const INSIGHT_TYPES = new Set([
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
]);

/**
 * Deterministic evidence planning: each claim's typed params fully determine its Qloo query
 * (ADR-023). Queries are deduplicated, checked against the allowlist, and trimmed to the
 * remaining Qloo budget by hypothesis priority (claims cut are UNTESTED_BUDGET).
 */
export function planEvidence(input: {
  claims: PlannableClaim[];
  entities: ReadonlyMap<string, PlanEntity>; // entity UUID → Qloo identity
  remainingQlooCalls: number;
  locationQlooId: string | null;
  timeWindowWeeks: number;
  today: string; // YYYY-MM-DD (injected clock)
}): EvidencePlanResult {
  const resolved = new Map<string, ResolvedParams>();
  const unsupported: { claimId: string; reason: string }[] = [];
  const byKey = new Map<
    string,
    PlannedQuery & { priority: number; order: number }
  >();
  const q = (id: string) => input.entities.get(id)?.qlooId;
  const domainOf = (id: string) => input.entities.get(id)?.domain ?? null;

  const ordered = [...input.claims].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.hypothesisId.localeCompare(b.hypothesisId) ||
      a.ordinal - b.ordinal,
  );
  ordered.forEach((claim, order) => {
    const p = claim.params;
    const signals = p.signalEntityIds.map(q);
    const params: ResolvedParams = {
      signalQlooIds: signals.filter((s): s is string => !!s),
      targetDomain: p.targetDomain,
      targetQlooId: p.targetEntityId ? q(p.targetEntityId) : undefined,
      tagQlooIds: p.tagEntityIds?.map(q).filter((s): s is string => !!s),
      optionQlooIds: p.optionEntityIds?.map(q).filter((s): s is string => !!s),
      compareQlooIds: p.compareEntityIds
        ?.map(q)
        .filter((s): s is string => !!s),
    };
    resolved.set(claim.claimId, params);
    if (signals.some((s) => !s)) {
      unsupported.push({
        claimId: claim.claimId,
        reason: "Unknown entity reference",
      });
      return;
    }
    let method: QueryMethod;
    let args: Record<string, unknown>;
    switch (claim.testKind) {
      case "CROSS_DOMAIN_AFFINITY":
        if (!p.targetDomain || !INSIGHT_TYPES.has(p.targetDomain)) {
          unsupported.push({
            claimId: claim.claimId,
            reason: "Target domain is not an Insights type",
          });
          return;
        }
        method = "recommend";
        args = {
          targetType: p.targetDomain,
          signals: params.signalQlooIds,
          ...(params.tagQlooIds?.length
            ? { includeTags: params.tagQlooIds }
            : {}),
          limit: 20,
        };
        break;
      case "SHORTLIST_FIT": {
        const optionType = p.targetEntityId ? domainOf(p.targetEntityId) : null;
        if (
          !optionType ||
          !INSIGHT_TYPES.has(optionType) ||
          (params.optionQlooIds?.length ?? 0) < 2
        ) {
          unsupported.push({
            claimId: claim.claimId,
            reason: "Shortlist options need one Insights type",
          });
          return;
        }
        method = "rank";
        args = {
          options: params.optionQlooIds,
          optionType,
          signals: params.signalQlooIds,
        };
        break;
      }
      case "AUDIENCE_BRIDGE":
        method = "compareAudiences";
        args = {
          groupA: params.signalQlooIds,
          groupB: params.compareQlooIds ?? [],
        };
        break;
      case "TAG_RESONANCE":
        method = "entityTags";
        args = { entities: params.signalQlooIds.slice(0, 1), limit: 20 };
        break;
      case "LOCATION_FIT":
        if (!input.locationQlooId) {
          unsupported.push({
            claimId: claim.claimId,
            reason: "No resolved venue locality",
          });
          return;
        }
        method = "wherePopular";
        args = {
          entity: params.signalQlooIds[0],
          within: input.locationQlooId,
        };
        break;
      case "MOMENTUM": {
        const type = domainOf(p.signalEntityIds[0]!);
        if (!type || !INSIGHT_TYPES.has(type)) {
          unsupported.push({
            claimId: claim.claimId,
            reason: "Momentum needs an Insights type",
          });
          return;
        }
        const end = new Date(`${input.today}T00:00:00Z`);
        const start = new Date(
          end.getTime() - input.timeWindowWeeks * 7 * 86_400_000,
        );
        method = "trends";
        args = {
          entities: params.signalQlooIds,
          entityType: type,
          startDate: start.toISOString().slice(0, 10),
          endDate: input.today,
        };
        break;
      }
      case "AUDIENCE_PROFILE":
        method = "audienceDemographics";
        args = { entity: params.signalQlooIds[0] };
        break;
    }
    if (!isAllowed("COLLECTING_EVIDENCE", method)) {
      unsupported.push({
        claimId: claim.claimId,
        reason: `${method} is not allowed`,
      });
      return;
    }
    const key = canonicalize({ method, args });
    const existing = byKey.get(key);
    if (existing) existing.claimIds.push(claim.claimId);
    else
      byKey.set(key, {
        key,
        method,
        input: args,
        claimIds: [claim.claimId],
        priority: claim.priority ?? 0,
        order,
      });
  });

  const all = [...byKey.values()].sort((a, b) => a.order - b.order);
  const kept = all.slice(0, Math.max(0, input.remainingQlooCalls));
  const cut = all.slice(kept.length);
  return {
    queries: kept.map(({ key, method, input: args, claimIds }) => ({
      key,
      method,
      input: args,
      claimIds,
    })),
    resolved,
    untestedBudget: cut.flatMap((c) => c.claimIds),
    unsupported,
  };
}
