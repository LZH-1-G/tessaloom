import type {
  ClaimTestKind,
  EvidenceFact,
  EvidenceStance,
  QlooMeasure,
} from "@tessaloom/core";
import type { QlooResult } from "./ports";

/**
 * Deterministic claim evaluators (AGENT_WORKFLOW §8.2, ADR-019). Parameters are versioned in
 * the ruleset; V1-introduced thresholds are placeholders until the M6 calibration.
 */
export const EVALUATION_RULESET = {
  version: "ruleset-2026.10-m4",
  K: 20,
  m: 3,
  delta: 0.05,
  sigmaMin: 0.02,
  omega: 1,
  alpha: 0.5,
  phi: 1.1,
  tagTypeAllowlist: [
    "genre",
    "subgenre",
    "keyword",
    "plot",
    "motif",
    "character",
    "style",
  ],
} as const;

/** Claim params with internal UUIDs already mapped to Qloo IDs. */
export interface ResolvedParams {
  signalQlooIds: string[];
  targetDomain?: string;
  targetQlooId?: string;
  tagQlooIds?: string[];
  optionQlooIds?: string[];
  compareQlooIds?: string[];
}

export interface Evaluation {
  stance: EvidenceStance;
  facts: EvidenceFact[];
  primaryMeasure: QlooMeasure;
  quality: "FULL" | "PARTIAL" | "DEGRADED" | "UNSUPPORTED" | "ERROR";
  claimStatus: "TESTED" | "UNSUPPORTED" | "FAILED";
  evaluatorId: string;
  note: string; // short plain-language reason for the activity feed
}

function resolvePointer(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (cur && typeof cur === "object" && Object.hasOwn(cur, key))
      cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

function fact(
  raw: unknown,
  statement: string,
  pointer: string,
  value: unknown,
  measure: QlooMeasure,
): EvidenceFact {
  // Raw retention is off: verify the pointer now, before the response is discarded.
  const verified =
    JSON.stringify(resolvePointer(raw, pointer)) === JSON.stringify(value);
  return {
    statement: statement.slice(0, 400),
    jsonPointer: pointer,
    value,
    measure,
    verifiedAtIngest: verified,
  };
}

function rawResults(raw: unknown): Record<string, unknown>[] {
  if (raw && typeof raw === "object" && "results" in raw) {
    const results = (raw as { results: unknown }).results;
    if (Array.isArray(results)) return results as Record<string, unknown>[];
  }
  return [];
}

/** Index of an entity in the raw `results[]` (pointers address the raw payload). */
function rawIndexOf(raw: unknown, qlooId: string): number {
  return rawResults(raw).findIndex(
    (r) => r.entity_id === qlooId || r.id === qlooId,
  );
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function failure(
  testKind: ClaimTestKind,
  result: QlooResult<unknown>,
): Evaluation | null {
  const evaluatorId = `${testKind}@${EVALUATION_RULESET.version}`;
  if (result.kind === "UNSUPPORTED")
    return {
      stance: "INSUFFICIENT",
      facts: [],
      primaryMeasure: "NONE",
      quality: "UNSUPPORTED",
      claimStatus: "UNSUPPORTED",
      evaluatorId,
      note: "Capability not supported for this type (no call made)",
    };
  if (result.kind === "ERROR")
    return {
      stance: "INSUFFICIENT",
      facts: [],
      primaryMeasure: "NONE",
      quality: "ERROR",
      claimStatus: "FAILED",
      evaluatorId,
      note: `Query failed (${result.code})`,
    };
  if (result.kind === "NEEDS_INPUT")
    return {
      stance: "INSUFFICIENT",
      facts: [],
      primaryMeasure: "NONE",
      quality: "ERROR",
      claimStatus: "FAILED",
      evaluatorId,
      note: "Ambiguous input (AMBIGUOUS_INPUT)",
    };
  if (result.kind === "EMPTY")
    return {
      stance: "INSUFFICIENT",
      facts: [],
      primaryMeasure: "NONE",
      quality: "FULL",
      claimStatus: "TESTED",
      evaluatorId,
      note: "Qloo returned no results",
    };
  return null;
}

type Ok<T> = Extract<QlooResult<T>, { kind: "OK" }>;

export function evaluateClaim(
  testKind: ClaimTestKind,
  params: ResolvedParams,
  result: QlooResult<unknown>,
): Evaluation {
  const failed = failure(testKind, result);
  if (failed) return failed;
  const ok = result as Ok<unknown>;
  const evaluatorId = `${testKind}@${EVALUATION_RULESET.version}`;
  const R = EVALUATION_RULESET;
  const base = {
    evaluatorId,
    quality: ok.quality,
    claimStatus: "TESTED" as const,
  };

  switch (testKind) {
    case "CROSS_DOMAIN_AFFINITY": {
      const items = (
        ok as Ok<{
          qlooId: string;
          affinity?: number;
          tags?: { tagId: string }[];
        }>
      ).items;
      const affinities = items
        .map((i) => i.affinity)
        .filter((a): a is number => typeof a === "number");
      const facts: EvidenceFact[] = [
        fact(
          ok.raw,
          `Qloo returned ${items.length} results`,
          "/result_count",
          (ok.raw as { result_count?: unknown })?.result_count,
          "RANK_POSITION",
        ),
      ].filter((f) => f.value !== undefined);
      if (
        affinities.length < 2 ||
        Math.max(...affinities) - Math.min(...affinities) < R.sigmaMin
      )
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts,
          primaryMeasure: "AUDIENCE_AFFINITY",
          note: "Affinity spread too flat to discriminate",
        };
      const med = median(affinities);
      if (params.targetQlooId) {
        const pos = items
          .slice(0, R.K)
          .findIndex((i) => i.qlooId === params.targetQlooId);
        if (pos >= 0) {
          const item = items[pos]!;
          const idx = rawIndexOf(ok.raw, item.qlooId);
          if (idx >= 0)
            facts.push(
              fact(
                ok.raw,
                `Target ranks #${pos + 1} with aggregate audience affinity ${item.affinity}`,
                `/results/${idx}/affinity`,
                item.affinity,
                "AUDIENCE_AFFINITY",
              ),
            );
          if ((item.affinity ?? -Infinity) >= med + R.delta)
            return {
              ...base,
              stance: "SUPPORTS",
              facts,
              primaryMeasure: "AUDIENCE_AFFINITY",
              note: `Target in top ${R.K} above median affinity`,
            };
          return {
            ...base,
            stance: "NEUTRAL",
            facts,
            primaryMeasure: "AUDIENCE_AFFINITY",
            note: "Target present but not above median + δ",
          };
        }
        if (items.length >= R.K)
          return {
            ...base,
            stance: "CONTRADICTS",
            facts,
            primaryMeasure: "RANK_POSITION",
            note: `Target absent from a full top ${R.K}`,
          };
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts,
          primaryMeasure: "RANK_POSITION",
          note: `Fewer than ${R.K} results`,
        };
      }
      if (params.tagQlooIds?.length) {
        const wanted = new Set(params.tagQlooIds);
        const matches = items
          .slice(0, R.K)
          .filter((i) => i.tags?.some((t) => wanted.has(t.tagId)));
        if (matches.length >= R.m)
          return {
            ...base,
            stance: "SUPPORTS",
            facts,
            primaryMeasure: "TAG_ASSOCIATION",
            note: `${matches.length} of top results carry the theme tag`,
          };
        if (items.length >= R.K && matches.length === 0)
          return {
            ...base,
            stance: "CONTRADICTS",
            facts,
            primaryMeasure: "TAG_ASSOCIATION",
            note: "No top result carries the theme tag",
          };
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts,
          primaryMeasure: "TAG_ASSOCIATION",
          note: "Too few tagged results",
        };
      }
      // Domain-only claim: discriminating affinities across ≥ m results.
      if (items.length >= R.m)
        return {
          ...base,
          stance: "SUPPORTS",
          facts,
          primaryMeasure: "AUDIENCE_AFFINITY",
          note: `${items.length} results with discriminating affinity`,
        };
      return {
        ...base,
        stance: "INSUFFICIENT",
        facts,
        primaryMeasure: "AUDIENCE_AFFINITY",
        note: "Too few results",
      };
    }
    case "SHORTLIST_FIT": {
      const items = (ok as Ok<{ qlooId: string; affinity?: number }>).items;
      const n = items.length;
      const pos = items.findIndex((i) => i.qlooId === params.targetQlooId);
      if (pos < 0 || n < 2)
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "RANK_POSITION",
          note: "Claimed element not ranked",
        };
      const third = Math.ceil(n / 3);
      const idx = rawIndexOf(ok.raw, items[pos]!.qlooId);
      const facts =
        idx >= 0
          ? [
              fact(
                ok.raw,
                `Claimed element ranks ${pos + 1} of ${n} by audience affinity`,
                `/results/${idx}/entity_id`,
                items[pos]!.qlooId,
                "RANK_POSITION",
              ),
            ]
          : [];
      if (pos < third)
        return {
          ...base,
          stance: "SUPPORTS",
          facts,
          primaryMeasure: "RANK_POSITION",
          note: `Ranked in the top ${third} of ${n}`,
        };
      if (pos >= n - third)
        return {
          ...base,
          stance: "CONTRADICTS",
          facts,
          primaryMeasure: "RANK_POSITION",
          note: `Ranked in the bottom ${third} of ${n}`,
        };
      return {
        ...base,
        stance: "NEUTRAL",
        facts,
        primaryMeasure: "RANK_POSITION",
        note: "Ranked mid-list",
      };
    }
    case "AUDIENCE_BRIDGE": {
      const cmp = (
        ok as Ok<{
          shared: { tagId: string; subtype?: string }[];
          a: { subtype?: string }[];
          b: { subtype?: string }[];
          matchEntities: unknown[];
        }>
      ).items[0];
      if (!cmp)
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "AUDIENCE_TAG_OVERLAP",
          note: "No comparison returned",
        };
      const subA = new Set(cmp.a.map((t) => t.subtype).filter(Boolean));
      const overlap = cmp.b.filter(
        (t) => t.subtype && subA.has(t.subtype),
      ).length;
      if (
        cmp.shared.length > 0 ||
        cmp.matchEntities.length > 0 ||
        overlap >= R.omega
      )
        return {
          ...base,
          stance: "SUPPORTS",
          facts: [],
          primaryMeasure: "AUDIENCE_TAG_OVERLAP",
          note: `${cmp.shared.length} shared tags, ${overlap} overlapping tag subtypes`,
        };
      // Absence in the top lists is not proof of disjoint audiences: never CONTRADICTS.
      return {
        ...base,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "AUDIENCE_TAG_OVERLAP",
        note: "No overlap in the returned tag profiles",
      };
    }
    case "TAG_RESONANCE": {
      const tags = (ok as Ok<{ tagId: string; tagType?: string }>).items;
      const wanted = new Set(params.tagQlooIds ?? []);
      const hit = tags.find(
        (t) =>
          wanted.has(t.tagId) &&
          (!t.tagType ||
            R.tagTypeAllowlist.some((a) => t.tagType!.includes(a))),
      );
      if (hit) {
        const idx = rawResults(ok.raw).findIndex(
          (r) => r.id === hit.tagId || r.tag_id === hit.tagId,
        );
        const facts =
          idx >= 0
            ? [
                fact(
                  ok.raw,
                  `Entity carries the theme tag ${hit.tagId}`,
                  `/results/${idx}`,
                  rawResults(ok.raw)[idx],
                  "TAG_ASSOCIATION",
                ),
              ]
            : [];
        return {
          ...base,
          stance: "SUPPORTS",
          facts,
          primaryMeasure: "TAG_ASSOCIATION",
          note: "Theme tag present with an allowed tag type",
        };
      }
      return {
        ...base,
        stance: "NEUTRAL",
        facts: [],
        primaryMeasure: "TAG_ASSOCIATION",
        note: "Theme tag not among the entity's tags",
      };
    }
    case "LOCATION_FIT": {
      const cells = (ok as Ok<{ affinity?: number }>).items;
      const top = Math.max(...cells.map((c) => c.affinity ?? 0));
      if (top >= R.alpha)
        return {
          ...base,
          stance: "SUPPORTS",
          facts: [],
          primaryMeasure: "GEO_AFFINITY",
          note: "A locality cell shows high audience concentration",
        };
      return {
        ...base,
        stance: "NEUTRAL",
        facts: [],
        primaryMeasure: "GEO_AFFINITY",
        note: "No strongly concentrated cell",
      };
    }
    case "MOMENTUM": {
      const series = (
        ok as Ok<{
          points: { rankVelocity?: number; velocityFoldChange?: number }[];
        }>
      ).items;
      const last = series.flatMap((s) => s.points).at(-1);
      if (!last)
        return {
          ...base,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "TREND",
          note: "No trend points returned",
        };
      if (
        (last.rankVelocity ?? 0) > 0 &&
        (last.velocityFoldChange ?? 0) >= R.phi
      )
        return {
          ...base,
          stance: "SUPPORTS",
          facts: [],
          primaryMeasure: "TREND",
          note: "Rank velocity rising",
        };
      return {
        ...base,
        stance: "NEUTRAL",
        facts: [],
        primaryMeasure: "TREND",
        note: "Trend flat",
      };
    }
    case "AUDIENCE_PROFILE":
      // Descriptive only: relative indices, never shares of people, never used to target.
      return {
        ...base,
        stance: "NEUTRAL",
        facts: [],
        primaryMeasure: "DEMOGRAPHIC_INDEX",
        note: "Aggregate audience profile recorded",
      };
  }
}
