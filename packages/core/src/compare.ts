/**
 * Comparison metrics (AGENT_WORKFLOW §15.3; APP_DERIVED). Pure and deterministic: the worker
 * computes them when a branch finishes, the web computes them for any two experiments, and
 * the narrative only ever renders numbers from here through `{{metric:ID}}` placeholders.
 */
export const METRICS_VERSION = "metrics-1.0.0";
export const RBO_P = 0.9;
export const OVERLAP_K = 20;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Jaccard similarity of the top-K id sets (1 when both are empty). */
export function overlapAtK(
  a: readonly string[],
  b: readonly string[],
  k = OVERLAP_K,
) {
  const A = new Set(a.slice(0, k));
  const B = new Set(b.slice(0, k));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return round(inter / (A.size + B.size - inter));
}

/**
 * Rank-Biased Overlap, extrapolated (Webber, Moffat & Zobel 2010, eq. 32), evaluated to the
 * depth of the shorter list. Identical lists give 1; disjoint lists give 0.
 */
export function rbo(a: readonly string[], b: readonly string[], p = RBO_P) {
  const k = Math.min(a.length, b.length);
  if (k === 0) return a.length === b.length ? 1 : 0;
  const seenA = new Set<string>();
  const seenB = new Set<string>();
  let overlap = 0;
  let sum = 0;
  for (let d = 1; d <= k; d++) {
    const x = a[d - 1]!;
    const y = b[d - 1]!;
    if (x === y) overlap++;
    else {
      if (seenB.has(x)) overlap++;
      if (seenA.has(y)) overlap++;
    }
    seenA.add(x);
    seenB.add(y);
    sum += (overlap / d) * p ** d;
  }
  return round((overlap / k) * p ** k + ((1 - p) / p) * sum);
}

export function enteredExited(
  base: readonly string[],
  other: readonly string[],
  k = OVERLAP_K,
) {
  const A = new Set(base.slice(0, k));
  const B = new Set(other.slice(0, k));
  return {
    entered: [...B].filter((x) => !A.has(x)),
    exited: [...A].filter((x) => !B.has(x)),
  };
}

// ---------------------------------------------------------------------------

export interface CompareEvidence {
  id: string;
  claimId: string;
  stance: string;
  toolInvocationId: string | null;
  dataOrigin: string | null;
  resultIds: string[] | null;
}

export interface CompareHypothesis {
  id: string;
  lineageId: string;
  title: string;
  status: string;
  retired: boolean;
  compositeScore: number | null;
  supportScore: number | null;
  noveltyScore: number | null;
  feasibilityScore: number | null;
  claims: {
    id: string;
    ordinal: number;
    statement: string;
    testKind: string;
    status: string;
    currentStance: string | null;
  }[];
  evidence: CompareEvidence[];
}

export interface CompareThread {
  seedEntityId: string;
  domain: string;
  /** Result entity ids in rank order. */
  entityIds: string[];
  toolInvocationId: string | null;
  dataOrigin: string | null;
}

export interface CompareSide {
  experimentId: string;
  hypotheses: CompareHypothesis[];
  threads: CompareThread[];
}

export interface QueryDiff {
  key: string;
  kind: "claim" | "discovery";
  label: string;
  baseIds: string[];
  otherIds: string[];
  overlapAtK: number;
  rbo: number;
  entered: string[];
  exited: string[];
  /** Branch evidence records graded from this query (citations). */
  evidenceIds: string[];
}

export interface HypothesisDelta {
  lineageId: string;
  title: string;
  baseId: string | null;
  otherId: string | null;
  baseStatus: string | null;
  otherStatus: string | null;
  statusChanged: boolean;
  baseComposite: number | null;
  otherComposite: number | null;
  compositeDelta: number | null;
  supportDelta: number | null;
  noveltyDelta: number | null;
  feasibilityDelta: number | null;
  baseRank: number | null;
  otherRank: number | null;
  rankShift: number | null;
}

export interface ClaimDelta {
  lineageId: string;
  hypothesisTitle: string;
  ordinal: number;
  statement: string;
  testKind: string;
  baseStance: string | null;
  otherStance: string | null;
  changed: boolean;
  baseEvidenceId: string | null;
  otherEvidenceId: string | null;
  /** True when the branch graded this claim from new data (not reused). */
  requeried: boolean;
}

export interface ComparisonMetrics {
  version: string;
  header: {
    dirtyQueries: number;
    reusedQueries: number;
    newQlooResults: number;
    changedStances: number;
    changedStatuses: number;
    driftIndex: number | null;
    rescoreOnly: boolean;
  };
  perQuery: QueryDiff[];
  perHypothesis: HypothesisDelta[];
  perClaim: ClaimDelta[];
  stanceDistribution: {
    base: Record<string, number>;
    other: Record<string, number>;
  };
}

const latest = (h: CompareHypothesis, claimId: string) =>
  [...h.evidence].reverse().find((e) => e.claimId === claimId) ?? null;

const ranks = (hyps: CompareHypothesis[]) =>
  new Map(
    [...hyps]
      .filter((h) => !h.retired)
      .sort(
        (a, b) =>
          (b.compositeScore ?? -1) - (a.compositeScore ?? -1) ||
          a.lineageId.localeCompare(b.lineageId),
      )
      .map((h, i) => [h.lineageId, i + 1]),
  );

const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? null : round(b - a);

/**
 * Compare a base experiment with another (a branch or a sibling). Hypotheses pair by lineage
 * (branches copy the parent's lineage ids); claims pair by ordinal. A query is "new" in
 * `other` when its evidence or thread came from an invocation that is not a CACHE reuse.
 */
export function compareExperiments(
  base: CompareSide,
  other: CompareSide,
  planned?: { dirtyQueries: number; reusedQueries: number },
): ComparisonMetrics {
  const active = (s: CompareSide) => s.hypotheses.filter((h) => !h.retired);
  const baseBy = new Map(active(base).map((h) => [h.lineageId, h]));
  const otherBy = new Map(active(other).map((h) => [h.lineageId, h]));
  const lineages = [...new Set([...baseBy.keys(), ...otherBy.keys()])].sort();
  const rb = ranks(active(base));
  const ro = ranks(active(other));
  // Everything the base already had (evidence and discovery threads). A branch copies the
  // parent's threads verbatim, so those are never "new" in the branch.
  const baseInvocations = new Set([
    ...base.hypotheses.flatMap((h) =>
      h.evidence.map((e) => e.toolInvocationId).filter(Boolean),
    ),
    ...base.threads.map((t) => t.toolInvocationId).filter(Boolean),
  ]);
  const isNew = (e: {
    toolInvocationId: string | null;
    dataOrigin: string | null;
  }) =>
    !!e.toolInvocationId &&
    e.dataOrigin !== "CACHE" &&
    !baseInvocations.has(e.toolInvocationId);

  const perHypothesis: HypothesisDelta[] = [];
  const perClaim: ClaimDelta[] = [];
  const perQuery = new Map<string, QueryDiff>();
  for (const lineage of lineages) {
    const b = baseBy.get(lineage) ?? null;
    const o = otherBy.get(lineage) ?? null;
    perHypothesis.push({
      lineageId: lineage,
      title: (o ?? b)!.title,
      baseId: b?.id ?? null,
      otherId: o?.id ?? null,
      baseStatus: b?.status ?? null,
      otherStatus: o?.status ?? null,
      statusChanged: !!b && !!o && b.status !== o.status,
      baseComposite: b?.compositeScore ?? null,
      otherComposite: o?.compositeScore ?? null,
      compositeDelta: delta(
        b?.compositeScore ?? null,
        o?.compositeScore ?? null,
      ),
      supportDelta: delta(b?.supportScore ?? null, o?.supportScore ?? null),
      noveltyDelta: delta(b?.noveltyScore ?? null, o?.noveltyScore ?? null),
      feasibilityDelta: delta(
        b?.feasibilityScore ?? null,
        o?.feasibilityScore ?? null,
      ),
      baseRank: rb.get(lineage) ?? null,
      otherRank: ro.get(lineage) ?? null,
      rankShift:
        rb.has(lineage) && ro.has(lineage)
          ? rb.get(lineage)! - ro.get(lineage)!
          : null,
    });
    if (!b || !o) continue;
    for (const oc of o.claims) {
      const bc = b.claims.find((c) => c.ordinal === oc.ordinal);
      const be = bc ? latest(b, bc.id) : null;
      const oe = latest(o, oc.id);
      const requeried = !!oe && isNew(oe);
      perClaim.push({
        lineageId: lineage,
        hypothesisTitle: o.title,
        ordinal: oc.ordinal,
        statement: oc.statement,
        testKind: oc.testKind,
        baseStance: bc?.currentStance ?? null,
        otherStance: oc.currentStance,
        changed: (bc?.currentStance ?? null) !== oc.currentStance,
        baseEvidenceId: be?.id ?? null,
        otherEvidenceId: oe?.id ?? null,
        requeried,
      });
      if (requeried && oe.resultIds) {
        const key = `claim:${oe.toolInvocationId}`;
        const existing = perQuery.get(key);
        if (existing) existing.evidenceIds.push(oe.id);
        else {
          const baseIds = be?.resultIds ?? [];
          perQuery.set(key, {
            key,
            kind: "claim",
            label: oc.statement,
            baseIds,
            otherIds: oe.resultIds,
            overlapAtK: overlapAtK(baseIds, oe.resultIds),
            rbo: rbo(baseIds, oe.resultIds),
            ...enteredExited(baseIds, oe.resultIds),
            evidenceIds: [oe.id],
          });
        }
      }
    }
  }
  for (const t of other.threads) {
    if (!isNew(t)) continue;
    const key = `discovery:${t.seedEntityId}:${t.domain}`;
    const parent = base.threads.find(
      (x) => x.seedEntityId === t.seedEntityId && x.domain === t.domain,
    );
    const baseIds = parent?.entityIds ?? [];
    perQuery.set(key, {
      key,
      kind: "discovery",
      label: `discovery thread into ${t.domain}`,
      baseIds,
      otherIds: t.entityIds,
      overlapAtK: overlapAtK(baseIds, t.entityIds),
      rbo: rbo(baseIds, t.entityIds),
      ...enteredExited(baseIds, t.entityIds),
      evidenceIds: [],
    });
  }

  const queries = [...perQuery.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const reusedInvocations = new Set(
    other.hypotheses.flatMap((h) =>
      h.evidence
        .filter((e) => e.dataOrigin === "CACHE")
        .map((e) => e.toolInvocationId),
    ),
  );
  const distribution = (s: CompareSide) => {
    const out: Record<string, number> = {};
    for (const h of active(s))
      for (const c of h.claims) {
        const k = c.currentStance ?? "UNTESTED";
        out[k] = (out[k] ?? 0) + 1;
      }
    return out;
  };
  const dirtyQueries = planned?.dirtyQueries ?? queries.length;
  return {
    version: METRICS_VERSION,
    header: {
      dirtyQueries,
      reusedQueries: planned?.reusedQueries ?? reusedInvocations.size,
      newQlooResults: queries.reduce((n, q) => n + q.otherIds.length, 0),
      changedStances: perClaim.filter((c) => c.changed).length,
      changedStatuses: perHypothesis.filter((h) => h.statusChanged).length,
      driftIndex: queries.length
        ? round(
            queries.reduce((n, q) => n + (1 - q.overlapAtK), 0) /
              queries.length,
          )
        : null,
      rescoreOnly: dirtyQueries === 0,
    },
    perQuery: queries,
    perHypothesis: perHypothesis.sort(
      (a, b) =>
        Math.abs(b.compositeDelta ?? 0) - Math.abs(a.compositeDelta ?? 0) ||
        a.lineageId.localeCompare(b.lineageId),
    ),
    perClaim,
    stanceDistribution: {
      base: distribution(base),
      other: distribution(other),
    },
  };
}

// ---------------------------------------------------------------------------
// Narrative: numbers only through placeholders (WI-A4).

/** Every number a narrative may render, by placeholder id. */
export function metricValues(m: ComparisonMetrics): Record<string, string> {
  const v: Record<string, string> = {
    dirtyQueries: String(m.header.dirtyQueries),
    reusedQueries: String(m.header.reusedQueries),
    newQlooResults: String(m.header.newQlooResults),
    changedStances: String(m.header.changedStances),
    changedStatuses: String(m.header.changedStatuses),
    driftIndex:
      m.header.driftIndex === null ? "n/a" : m.header.driftIndex.toFixed(2),
    claimsTotal: String(m.perClaim.length),
    hypothesesTotal: String(m.perHypothesis.length),
  };
  m.perHypothesis.forEach((h, i) => {
    v[`h${i}.compositeDelta`] =
      h.compositeDelta === null
        ? "n/a"
        : `${h.compositeDelta > 0 ? "+" : ""}${h.compositeDelta.toFixed(1)}`;
    v[`h${i}.rankShift`] = h.rankShift === null ? "n/a" : String(h.rankShift);
  });
  return v;
}

export function renderNarrative(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(/\{\{metric:([A-Za-z0-9_.-]+)\}\}/g, (_, id: string) =>
    Object.hasOwn(values, id) ? values[id]! : "?",
  );
}

const pretty = (s: string | null) =>
  s ? s.replace(/_/g, " ").toLowerCase() : "untested";

/**
 * Deterministic narrative (APP_DERIVED): always available, used when the AI narrative is
 * unavailable or rejected. A rescore-only comparison never claims new data.
 */
export function templateNarrative(m: ComparisonMetrics): string {
  const parts: string[] = [];
  if (m.header.rescoreOnly)
    parts.push(
      "Rescored with existing evidence — no new Qloo data was retrieved.",
    );
  else
    parts.push(
      "The branch re-queried {{metric:dirtyQueries}} Qloo queries and reused {{metric:reusedQueries}}; {{metric:newQlooResults}} results came back from the new queries.",
    );
  parts.push(
    "{{metric:changedStances}} of {{metric:claimsTotal}} claims changed stance; {{metric:changedStatuses}} of {{metric:hypothesesTotal}} hypotheses changed status.",
  );
  const moved = m.perHypothesis.findIndex(
    (h) => h.statusChanged || (h.compositeDelta ?? 0) !== 0,
  );
  if (moved >= 0) {
    const h = m.perHypothesis[moved]!;
    parts.push(
      h.statusChanged
        ? `The largest change: "${h.title}" moved from ${pretty(h.baseStatus)} to ${pretty(h.otherStatus)} (composite {{metric:h${moved}.compositeDelta}}).`
        : `The largest change: "${h.title}" stayed ${pretty(h.otherStatus)}, with its composite score moving {{metric:h${moved}.compositeDelta}}.`,
    );
  }
  if (m.header.driftIndex !== null)
    parts.push(
      "Across the re-queried results the drift index is {{metric:driftIndex}}.",
    );
  return parts.join(" ");
}
