import { canonicalize } from "./jcs";
import type { ClaimTestKind } from "./enums";
import { planEvidence, type PlanEntity, type ResolvedParams } from "./planner";
import type { ClaimParams } from "./schemas/domain";
import type { ExperimentVariables, VariableDelta } from "./schemas/experiment";

/**
 * Counterfactual dependency analysis (AGENT_WORKFLOW §15.2, ADR-027). Pure: the web process
 * runs it for the preview and at branch creation, and the result is stored with the branch.
 *
 * Hold-fixed mode keeps the parent's hypotheses and claims. Each claim is re-planned under
 * the branch variables with the same deterministic planner; a claim whose query *and*
 * evaluator inputs are unchanged keeps the parent's outcome (REUSE with evidence, INHERIT
 * without), everything else is DIRTY and must be re-queried. Adding a target domain adds
 * discovery queries for it. Weights, constraints and tension never touch Qloo.
 */
export const COUNTERFACTUAL_VERSION = "counterfactual-1.0.0";
export const AUTO_APPROVE_QLOO_CALLS = 6;
/** Discovery threads keep the top k per (seed, domain), as in the root run. */
export const BRANCH_THREAD_K = 10;

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

export interface CfEntity {
  id: string;
  qlooId: string;
  domain: string | null;
  kind: "entity" | "tag" | "locality";
  name: string;
}

export interface CfClaim {
  id: string;
  ordinal: number;
  statement: string;
  testKind: ClaimTestKind;
  params: ClaimParams;
  status: string;
  stance: string | null;
  /** The parent's latest evidence record for this claim, if any. */
  evidenceId: string | null;
}

export interface CfHypothesis {
  id: string;
  title: string;
  compositeScore: number | null;
  claims: CfClaim[];
}

export interface CounterfactualInput {
  /** The parent's active (non-retired) hypotheses. */
  hypotheses: CfHypothesis[];
  entities: ReadonlyMap<string, CfEntity>;
  seeds: { entityId: string; role: "seed" | "location" | "tag_constraint" }[];
  variables: ExperimentVariables;
  delta: VariableDelta;
  /** The date the parent's evidence was planned for (keeps trend windows comparable). */
  today: string;
}

export type ClaimDecision = "REUSE" | "INHERIT" | "DIRTY" | "UNSUPPORTED";

export interface PlannedClaim {
  parentClaimId: string;
  hypothesisId: string;
  ordinal: number;
  statement: string;
  testKind: ClaimTestKind;
  params: ClaimParams;
  decision: ClaimDecision;
  reason: string;
  parentKey: string | null;
  branchKey: string | null;
  method: string | null;
}

export interface DiscoveryQuery {
  seedEntityId: string;
  domain: string;
  key: string;
}

export interface CounterfactualPlan {
  version: string;
  variables: ExperimentVariables;
  seeds: { entityId: string; role: "seed" | "location" | "tag_constraint" }[];
  swaps: Record<string, string>;
  claims: PlannedClaim[];
  discovery: DiscoveryQuery[];
  /** Unique Qloo queries the branch must execute (claims + discovery). */
  dirtyQueries: number;
  /** Unique parent queries whose results carry over unchanged. */
  reusedQueries: number;
  estimatedQlooCalls: number;
  rescoreOnly: boolean;
  needsConfirmation: boolean;
  /** Human-readable list of the dirty queries (preview, H4 card). */
  dirtyList: { method: string; label: string; reason: string }[];
  /** Delta parts that this harness contract cannot apply (reject the branch). */
  unsupported: string[];
}

const remap = (
  params: ClaimParams,
  swaps: Record<string, string>,
  removed: Set<string>,
): ClaimParams => {
  const one = (id: string) => swaps[id] ?? id;
  const many = (ids?: string[]) =>
    ids?.map(one).filter((id) => !removed.has(id));
  return {
    ...params,
    signalEntityIds: many(params.signalEntityIds) ?? [],
    ...(params.targetEntityId
      ? { targetEntityId: one(params.targetEntityId) }
      : {}),
    ...(params.tagEntityIds ? { tagEntityIds: many(params.tagEntityIds) } : {}),
    ...(params.optionEntityIds
      ? { optionEntityIds: many(params.optionEntityIds) }
      : {}),
    ...(params.compareEntityIds
      ? { compareEntityIds: many(params.compareEntityIds) }
      : {}),
  } as ClaimParams;
};

const describeMethod: Record<string, string> = {
  recommend: "cross-domain recommendation",
  rank: "shortlist ranking",
  compareAudiences: "audience comparison",
  entityTags: "entity tags",
  wherePopular: "where popular",
  trends: "trend series",
  audienceDemographics: "audience profile",
};

/** Apply a delta to the parent variables (no Qloo, no randomness). */
export function applyVariableDelta(
  variables: ExperimentVariables,
  delta: VariableDelta,
  locationQlooId: string | null,
): ExperimentVariables {
  const domains = new Set(variables.targetDomains);
  delta.targetDomains?.add?.forEach((d) => domains.add(d));
  delta.targetDomains?.remove?.forEach((d) => domains.delete(d));
  return {
    ...variables,
    targetDomains: [...domains].sort() as ExperimentVariables["targetDomains"],
    locationQlooId:
      delta.location === undefined ? variables.locationQlooId : locationQlooId,
    timeWindowWeeks: delta.timeWindow?.weeks ?? variables.timeWindowWeeks,
    collisionTension: delta.collisionTension ?? variables.collisionTension,
    constraints: delta.constraints
      ? { ...variables.constraints, ...delta.constraints }
      : variables.constraints,
  };
}

export function planCounterfactual(
  input: CounterfactualInput,
): CounterfactualPlan {
  const { delta } = input;
  const unsupported: string[] = [];
  if (delta.seeds?.add?.length)
    unsupported.push(
      "Adding a seed needs ad hoc entity resolution, which is not available yet; swap an existing seed instead",
    );
  if (delta.tagConstraints)
    unsupported.push(
      "Tag constraints need harness tag filters that are not confirmed (PENDING)",
    );
  if (delta.audienceBand !== undefined)
    unsupported.push(
      "Audience bands need a confirmed demographic signal in the harness (PENDING)",
    );

  const seedIds = new Set(
    input.seeds.filter((s) => s.role === "seed").map((s) => s.entityId),
  );
  const swaps: Record<string, string> = {};
  const swapTargets = new Set<string>();
  const swappedAway = new Set((delta.seeds?.swap ?? []).map((s) => s.from));
  for (const s of delta.seeds?.swap ?? []) {
    if (swapTargets.has(s.to) || (seedIds.has(s.to) && !swappedAway.has(s.to)))
      unsupported.push(
        `${input.entities.get(s.to)?.name ?? s.to} is already a seed of this branch`,
      );
    swapTargets.add(s.to);
    if (!seedIds.has(s.from))
      unsupported.push(
        `Swap source ${s.from} is not a seed of this experiment`,
      );
    else if (!input.entities.has(s.to))
      unsupported.push(
        `Swap target ${s.to} is not an entity of this experiment`,
      );
    else swaps[s.from] = s.to;
  }
  const removed = new Set(
    (delta.seeds?.remove ?? []).filter((id) => seedIds.has(id)),
  );

  const parentLocation =
    input.seeds.find((s) => s.role === "location")?.entityId ?? null;
  let branchLocation = parentLocation;
  if (delta.location === null) branchLocation = null;
  else if (delta.location) {
    const e = input.entities.get(delta.location.localityEntityId);
    if (!e || e.kind !== "locality")
      unsupported.push("The new location must be a resolved locality");
    else branchLocation = e.id;
  }
  const qid = (id: string | null) =>
    id ? (input.entities.get(id)?.qlooId ?? null) : null;
  const variables = applyVariableDelta(
    input.variables,
    delta,
    qid(branchLocation),
  );
  const removedDomains = new Set(delta.targetDomains?.remove ?? []);

  const seeds = [
    ...input.seeds
      .filter((s) => s.role !== "location")
      .filter((s) => !removed.has(s.entityId))
      .map((s) => ({ ...s, entityId: swaps[s.entityId] ?? s.entityId })),
    ...(branchLocation
      ? [{ entityId: branchLocation, role: "location" as const }]
      : []),
  ];

  const planEntities = new Map<string, PlanEntity>();
  for (const [id, e] of input.entities)
    planEntities.set(id, { qlooId: e.qlooId, domain: e.domain, kind: e.kind });

  const plan = (
    params: (c: CfClaim) => ClaimParams,
    locationQlooId: string | null,
    weeks: number,
  ) => {
    const claims = input.hypotheses.flatMap((h) =>
      h.claims.map((c) => ({
        claimId: c.id,
        hypothesisId: h.id,
        testKind: c.testKind,
        params: params(c),
        priority: h.compositeScore,
        ordinal: c.ordinal,
      })),
    );
    const result = planEvidence({
      claims: claims.filter((c) => c.params.signalEntityIds.length > 0),
      entities: planEntities,
      remainingQlooCalls: Number.MAX_SAFE_INTEGER,
      locationQlooId,
      timeWindowWeeks: weeks,
      today: input.today,
    });
    const keyOf = new Map<string, { key: string; method: string }>();
    for (const q of result.queries)
      for (const id of q.claimIds)
        keyOf.set(id, { key: q.key, method: q.method });
    const unsupportedReason = new Map(
      result.unsupported.map((u) => [u.claimId, u.reason]),
    );
    return { keyOf, resolved: result.resolved, unsupportedReason };
  };

  const parentPlan = plan(
    (c) => c.params,
    qid(parentLocation),
    input.variables.timeWindowWeeks,
  );
  const branchParams = new Map<string, ClaimParams>();
  for (const h of input.hypotheses)
    for (const c of h.claims)
      branchParams.set(c.id, remap(c.params, swaps, removed));
  const branchPlan = plan(
    (c) => branchParams.get(c.id)!,
    qid(branchLocation),
    variables.timeWindowWeeks,
  );
  const same = (a?: ResolvedParams, b?: ResolvedParams) =>
    !!a && !!b && canonicalize(a) === canonicalize(b);

  const claims: PlannedClaim[] = [];
  for (const h of input.hypotheses)
    for (const c of h.claims) {
      const params = branchParams.get(c.id)!;
      const parentQ = parentPlan.keyOf.get(c.id) ?? null;
      const branchQ = branchPlan.keyOf.get(c.id) ?? null;
      const base = {
        parentClaimId: c.id,
        hypothesisId: h.id,
        ordinal: c.ordinal,
        statement: c.statement,
        testKind: c.testKind,
        params,
        parentKey: parentQ?.key ?? null,
        branchKey: branchQ?.key ?? null,
        method: branchQ?.method ?? parentQ?.method ?? null,
      };
      if (params.targetDomain && removedDomains.has(params.targetDomain)) {
        claims.push({
          ...base,
          decision: "UNSUPPORTED",
          reason: "Its target domain was removed in this branch",
        });
        continue;
      }
      if (params.signalEntityIds.length === 0) {
        claims.push({
          ...base,
          decision: "UNSUPPORTED",
          reason: "Its only signal seed was removed in this branch",
        });
        continue;
      }
      if (!branchQ) {
        claims.push({
          ...base,
          decision: "UNSUPPORTED",
          reason: branchPlan.unsupportedReason.get(c.id) ?? "Not plannable",
        });
        continue;
      }
      const unchanged =
        parentQ?.key === branchQ.key &&
        same(parentPlan.resolved.get(c.id), branchPlan.resolved.get(c.id));
      if (unchanged && c.status === "TESTED" && c.evidenceId)
        claims.push({ ...base, decision: "REUSE", reason: "Unchanged query" });
      else if (unchanged && c.status !== "PLANNED")
        claims.push({
          ...base,
          decision: "INHERIT",
          reason: `Unchanged; keeps the parent's outcome (${c.status.toLowerCase()})`,
        });
      else
        claims.push({
          ...base,
          decision: "DIRTY",
          reason: !parentQ
            ? "New query"
            : parentQ.key !== branchQ.key
              ? "Its query changed"
              : "Its evaluator inputs changed",
        });
    }

  // Discovery threads into added target domains (seed × new domain).
  const added = (delta.targetDomains?.add ?? []).filter(
    (d) => INSIGHT_TYPES.has(d) && !input.variables.targetDomains.includes(d),
  );
  const discovery: DiscoveryQuery[] = [];
  for (const s of seeds.filter((x) => x.role === "seed"))
    for (const domain of added) {
      const e = input.entities.get(s.entityId);
      if (!e || e.domain === domain) continue;
      discovery.push({
        seedEntityId: e.id,
        domain,
        key: canonicalize({
          method: "recommend",
          args:
            e.kind === "tag"
              ? {
                  targetType: domain,
                  signalTags: [e.qlooId],
                  limit: BRANCH_THREAD_K,
                }
              : {
                  targetType: domain,
                  signals: [e.qlooId],
                  limit: BRANCH_THREAD_K,
                },
        }),
      });
    }

  const dirtyKeys = new Map<string, PlannedClaim>();
  for (const c of claims)
    if (c.decision === "DIRTY" && c.branchKey && !dirtyKeys.has(c.branchKey))
      dirtyKeys.set(c.branchKey, c);
  const reusedKeys = new Set(
    claims
      .filter((c) => c.decision === "REUSE" && c.parentKey)
      .map((c) => c.parentKey!),
  );
  const dirtyQueries = dirtyKeys.size + discovery.length;
  const name = (id: string) => input.entities.get(id)?.name ?? "an entity";
  return {
    version: COUNTERFACTUAL_VERSION,
    variables,
    seeds,
    swaps,
    claims,
    discovery,
    dirtyQueries,
    reusedQueries: reusedKeys.size,
    estimatedQlooCalls: dirtyQueries,
    rescoreOnly: dirtyQueries === 0,
    needsConfirmation: dirtyQueries > AUTO_APPROVE_QLOO_CALLS,
    dirtyList: [
      ...[...dirtyKeys.values()].map((c) => ({
        method: c.method ?? "unknown",
        label: `${describeMethod[c.method ?? ""] ?? c.method} for "${c.statement}"`,
        reason: c.reason,
      })),
      ...discovery.map((d) => ({
        method: "recommend",
        label: `discovery thread: ${d.domain} for audiences of ${name(d.seedEntityId)}`,
        reason: "Target domain added",
      })),
    ],
    unsupported,
  };
}
