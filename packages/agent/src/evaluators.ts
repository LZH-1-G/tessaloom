import type {
  ClaimTestKind,
  EvidenceFact,
  EvidenceStance,
  QlooMeasure,
} from "@tessaloom/core";
import type { ResolvedParams } from "@tessaloom/core";
import type { QlooResult } from "./ports";

/**
 * Deterministic claim evaluators (AGENT_WORKFLOW §8.2, ADR-019, ADR-025).
 *
 * Every rule is either *rank- or structure-based* — justified by the V1 observation that
 * absolute affinities are not comparable across calls and can be flat (0.883–0.899 for one
 * book → movies, V1 finding 7) — or it is *pending live calibration* and then returns
 * INSUFFICIENT with that note instead of an invented threshold. Qloo numbers are aggregate
 * audience signals; no evaluator turns them into a creative-fit score.
 */
export const EVALUATION_RULESET = {
  version: "ruleset-2026.10-m6",
  /** recommend/rank limit used for evidence (harness maximum per call). */
  K: 20,
  /** Minimum tag-filtered results for a theme claim (AGENT_WORKFLOW §8.2 default m = 3). */
  m: 3,
  /** Affinities closer than this are reported ties (they are published at 3 decimals). */
  tieEpsilon: 0.005,
  /** V1 finding 6: tag types that describe content; endorsement/format tags are noise. */
  tagTypeAllowlist: [
    "genre",
    "subgenre",
    "keyword",
    "plot",
    "theme",
    "motif",
    "character",
    "style",
  ],
  /** Points of a trend series considered for momentum (latest first). */
  momentumWindow: 3,
} as const;

export const PENDING_CALIBRATION = "evaluator pending live calibration";

export type { ResolvedParams } from "@tessaloom/core";
export interface Evaluation {
  stance: EvidenceStance;
  facts: EvidenceFact[];
  primaryMeasure: QlooMeasure;
  quality:
    | "FULL"
    | "PARTIAL"
    | "DEGRADED"
    | "FIELD_UNAVAILABLE"
    | "UNSUPPORTED"
    | "ERROR";
  claimStatus: "TESTED" | "UNSUPPORTED" | "FAILED";
  evaluatorId: string;
  /** Plain-language rule, e.g. "SUPPORTS because the target ranked 2 of 20 (top quartile)". */
  note: string;
}

type Raw = Record<string, unknown>;

function resolvePointer(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (cur && typeof cur === "object" && Object.hasOwn(cur, key))
      cur = (cur as Raw)[key];
    else return undefined;
  }
  return cur;
}

/** A fact whose pointer is verified against the response before it is discarded (R-08). */
function fact(
  raw: unknown,
  statement: string,
  pointer: string,
  measure: QlooMeasure,
): EvidenceFact | null {
  const value = resolvePointer(raw, pointer);
  if (value === undefined) return null;
  return {
    statement: statement.slice(0, 400),
    jsonPointer: pointer,
    value,
    measure,
    verifiedAtIngest: true,
  };
}

const compact = (facts: (EvidenceFact | null)[]) =>
  facts.filter((f): f is EvidenceFact => f !== null);

function rawResults(raw: unknown, key = "results"): Raw[] {
  const value = raw && typeof raw === "object" ? (raw as Raw)[key] : undefined;
  return Array.isArray(value) ? (value as Raw[]) : [];
}

const rawIndexOf = (raw: unknown, qlooId: string) =>
  rawResults(raw).findIndex((r) => r.entity_id === qlooId || r.id === qlooId);

function base(
  testKind: ClaimTestKind,
  quality: Evaluation["quality"] = "FULL",
) {
  return {
    evaluatorId: `${testKind}@${EVALUATION_RULESET.version}`,
    quality,
    claimStatus: "TESTED" as const,
  };
}

function failure(
  testKind: ClaimTestKind,
  result: QlooResult<unknown>,
): Evaluation | null {
  const b = base(testKind);
  switch (result.kind) {
    case "UNSUPPORTED":
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "NONE",
        quality: "UNSUPPORTED",
        claimStatus: "UNSUPPORTED",
        note: `Untestable: ${result.reason}`,
      };
    case "ERROR":
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "NONE",
        quality: "ERROR",
        claimStatus: "FAILED",
        note: `Not tested — Qloo request failed (${result.code})`,
      };
    case "NEEDS_INPUT":
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "NONE",
        quality: "ERROR",
        claimStatus: "FAILED",
        note: "Not tested — an input was ambiguous (AMBIGUOUS_INPUT)",
      };
    case "EMPTY":
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "NONE",
        note: "INSUFFICIENT because Qloo returned no results; absence is not evidence against the claim",
      };
    default:
      return null;
  }
}

type Ok<T> = Extract<QlooResult<T>, { kind: "OK" }>;
type Ranked = { qlooId: string; affinity?: number; tags?: { tagId: string }[] };

function crossDomain(params: ResolvedParams, ok: Ok<Ranked>): Evaluation {
  const R = EVALUATION_RULESET;
  const items = ok.items;
  const n = items.length;
  const b = base("CROSS_DOMAIN_AFFINITY", ok.quality);
  const countFact = fact(
    ok.raw,
    `Qloo returned ${n} results`,
    "/result_count",
    "RANK_POSITION",
  );
  if (params.tagQlooIds?.length) {
    // Theme claims run with include_tags, so every result already carries the theme.
    if (n >= R.m)
      return {
        ...b,
        stance: "SUPPORTS",
        facts: compact([countFact]),
        primaryMeasure: "TAG_ASSOCIATION",
        note: `SUPPORTS because ${n} results carry the theme tag under the include_tags filter (≥ ${R.m})`,
      };
    return {
      ...b,
      stance: "INSUFFICIENT",
      facts: compact([countFact]),
      primaryMeasure: "TAG_ASSOCIATION",
      note: `INSUFFICIENT because only ${n} tagged results came back (< ${R.m}); this is not evidence against the theme`,
    };
  }
  if (!params.targetQlooId)
    // Qloo returns results of a domain for any signal, so a domain-only claim cannot discriminate.
    return {
      ...b,
      stance: "NEUTRAL",
      facts: compact([countFact]),
      primaryMeasure: "AUDIENCE_AFFINITY",
      note: "NEUTRAL because a domain-only claim is not discriminating: Qloo returns results for any signal",
    };
  const position = items.findIndex((i) => i.qlooId === params.targetQlooId);
  if (position < 0) {
    if (n >= R.K)
      return {
        ...b,
        stance: "CONTRADICTS",
        facts: compact([countFact]),
        primaryMeasure: "RANK_POSITION",
        note: `CONTRADICTS because the target is absent from a full top ${R.K}`,
      };
    return {
      ...b,
      stance: "INSUFFICIENT",
      facts: compact([countFact]),
      primaryMeasure: "RANK_POSITION",
      note: `INSUFFICIENT because only ${n} results came back (< ${R.K}), so absence is not evidence`,
    };
  }
  const idx = rawIndexOf(ok.raw, params.targetQlooId);
  const positionFact =
    idx >= 0
      ? fact(
          ok.raw,
          `Target ranks ${position + 1} of ${n} by aggregate audience affinity`,
          `/results/${idx}/entity_id`,
          "RANK_POSITION",
        )
      : null;
  const affinities = items.map((i) => i.affinity);
  if (affinities.some((a) => typeof a !== "number"))
    return {
      ...b,
      quality: "FIELD_UNAVAILABLE",
      stance: "INSUFFICIENT",
      facts: compact([positionFact]),
      primaryMeasure: "RANK_POSITION",
      note: "INSUFFICIENT because Qloo did not return affinity values for this result set",
    };
  const values = affinities as number[];
  const affinityFact =
    idx >= 0
      ? fact(
          ok.raw,
          `Target aggregate audience affinity ${values[position]}`,
          `/results/${idx}/affinity`,
          "AUDIENCE_AFFINITY",
        )
      : null;
  const facts = compact([positionFact, affinityFact, countFact]);
  if (Math.max(...values) - Math.min(...values) < R.tieEpsilon)
    return {
      ...b,
      stance: "NEUTRAL",
      facts,
      primaryMeasure: "AUDIENCE_AFFINITY",
      note: "NEUTRAL because the affinities are effectively tied, so rank carries no signal",
    };
  const quartile = Math.ceil(n / 4);
  if (position < quartile)
    return {
      ...b,
      stance: "SUPPORTS",
      facts,
      primaryMeasure: "RANK_POSITION",
      note: `SUPPORTS because the target ranked ${position + 1} of ${n} (top quartile by aggregate affinity)`,
    };
  return {
    ...b,
    stance: "NEUTRAL",
    facts,
    primaryMeasure: "RANK_POSITION",
    note: `NEUTRAL because the target ranked ${position + 1} of ${n}, present but outside the top quartile`,
  };
}

export function evaluateClaim(
  testKind: ClaimTestKind,
  params: ResolvedParams,
  result: QlooResult<unknown>,
): Evaluation {
  const failed = failure(testKind, result);
  if (failed) return failed;
  const ok = result as Ok<unknown>;
  const R = EVALUATION_RULESET;
  const b = base(testKind, ok.quality);

  switch (testKind) {
    case "CROSS_DOMAIN_AFFINITY":
      return crossDomain(params, ok as Ok<Ranked>);
    case "SHORTLIST_FIT": {
      // rank orders the options by affinity for the signals; scores are not compared across calls.
      const items = (ok as Ok<Ranked>).items;
      const n = items.length;
      const position = items.findIndex((i) => i.qlooId === params.targetQlooId);
      if (position < 0 || n < 3)
        return {
          ...b,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "RANK_POSITION",
          note:
            n < 3
              ? "INSUFFICIENT because fewer than 3 options were ranked"
              : "INSUFFICIENT because the claimed option was not ranked",
        };
      const third = Math.ceil(n / 3);
      const idx = rawIndexOf(ok.raw, params.targetQlooId!);
      const facts = compact([
        idx >= 0
          ? fact(
              ok.raw,
              `Claimed option ranks ${position + 1} of ${n}`,
              `/results/${idx}/entity_id`,
              "RANK_POSITION",
            )
          : null,
      ]);
      if (position < third)
        return {
          ...b,
          stance: "SUPPORTS",
          facts,
          primaryMeasure: "RANK_POSITION",
          note: `SUPPORTS because the claimed option ranked ${position + 1} of ${n} (top third)`,
        };
      if (position >= n - third)
        return {
          ...b,
          stance: "CONTRADICTS",
          facts,
          primaryMeasure: "RANK_POSITION",
          note: `CONTRADICTS because the claimed option ranked ${position + 1} of ${n} (bottom third)`,
        };
      return {
        ...b,
        stance: "NEUTRAL",
        facts,
        primaryMeasure: "RANK_POSITION",
        note: `NEUTRAL because the claimed option ranked ${position + 1} of ${n} (middle third)`,
      };
    }
    case "AUDIENCE_BRIDGE": {
      // V1: tag profiles without a similarity score. Shared tags / match entities are structural
      // evidence; tag-subtype overlap needs a calibrated threshold (pending live calibration).
      const cmp = (ok as Ok<{ shared: unknown[]; matchEntities: unknown[] }>)
        .items[0];
      if (!cmp)
        return {
          ...b,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "AUDIENCE_TAG_OVERLAP",
          note: "INSUFFICIENT because no comparison was returned",
        };
      const results = (ok.raw as Raw | null)?.results as Raw | undefined;
      const sharedFact = cmp.shared.length
        ? fact(
            ok.raw,
            `${cmp.shared.length} tags are shared by both audiences`,
            "/results/tags/0/tag_id",
            "AUDIENCE_TAG_OVERLAP",
          )
        : null;
      const matchFact =
        cmp.matchEntities.length && Array.isArray(results?.matchEntities)
          ? fact(
              ok.raw,
              `${cmp.matchEntities.length} entities match both audiences`,
              "/results/matchEntities/0",
              "AUDIENCE_TAG_OVERLAP",
            )
          : null;
      if (cmp.shared.length > 0 || cmp.matchEntities.length > 0)
        return {
          ...b,
          stance: "SUPPORTS",
          facts: compact([sharedFact, matchFact]),
          primaryMeasure: "AUDIENCE_TAG_OVERLAP",
          note: `SUPPORTS because Qloo lists ${cmp.shared.length} shared tags and ${cmp.matchEntities.length} matching entities`,
        };
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts: [],
        primaryMeasure: "AUDIENCE_TAG_OVERLAP",
        note: `INSUFFICIENT: no shared tags or entities; tag-subtype overlap is an ${PENDING_CALIBRATION}. Absence in the top lists is not proof of disjoint audiences`,
      };
    }
    case "TAG_RESONANCE": {
      const tags = (ok as Ok<{ tagId: string; tagType?: string; name: string }>)
        .items;
      const wanted = new Set(params.tagQlooIds ?? []);
      const hit = tags.find((t) => wanted.has(t.tagId));
      if (!hit)
        return {
          ...b,
          stance: "NEUTRAL",
          facts: [],
          primaryMeasure: "TAG_ASSOCIATION",
          note: "NEUTRAL because the theme tag is not among the entity's top tags",
        };
      const allowed =
        !hit.tagType ||
        R.tagTypeAllowlist.some(
          (a) => hit.tagType!.includes(`:${a}`) || hit.tagType!.endsWith(a),
        );
      const idx = rawResults(ok.raw).findIndex(
        (r) => r.id === hit.tagId || r.tag_id === hit.tagId,
      );
      const facts = compact([
        idx >= 0
          ? fact(
              ok.raw,
              `Entity carries the tag "${hit.name}"`,
              `/results/${idx}/id`,
              "TAG_ASSOCIATION",
            )
          : null,
      ]);
      if (!allowed)
        return {
          ...b,
          stance: "NEUTRAL",
          facts,
          primaryMeasure: "TAG_ASSOCIATION",
          note: `NEUTRAL because the matching tag's type (${hit.tagType}) does not describe content (V1 finding 6)`,
        };
      return {
        ...b,
        stance: "SUPPORTS",
        facts,
        primaryMeasure: "TAG_ASSOCIATION",
        note: `SUPPORTS because the entity carries the theme tag "${hit.name}" with a content tag type`,
      };
    }
    case "LOCATION_FIT": {
      // V1 finding 10: intra-city geohash cells; without venue coordinates and a calibrated
      // concentration threshold this is descriptive only.
      const cells = rawResults(ok.raw);
      const facts = compact([
        cells.length
          ? fact(
              ok.raw,
              "Top cell aggregate affinity within the locality",
              "/results/0/query/affinity",
              "GEO_AFFINITY",
            )
          : null,
      ]);
      return {
        ...b,
        stance: "INSUFFICIENT",
        facts,
        primaryMeasure: "GEO_AFFINITY",
        note: `INSUFFICIENT: ${cells.length} locality cells recorded; the concentration test is an ${PENDING_CALIBRATION} and venue coordinates are unknown`,
      };
    }
    case "MOMENTUM": {
      // Sign-based: a positive rank velocity means the rank is improving (definition, no threshold).
      const series = rawResults(ok.raw, "series");
      const points = (series[0]?.points as Raw[] | undefined) ?? [];
      if (points.length === 0)
        return {
          ...b,
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "TREND",
          note: "INSUFFICIENT because the trend series has no points for this type and window (V1 finding 11)",
        };
      const recent = points.slice(-R.momentumWindow).map((p, i, arr) => ({
        v: p.population_rank_velocity,
        index: points.length - arr.length + i,
      }));
      if (recent.some((p) => typeof p.v !== "number"))
        return {
          ...b,
          quality: "FIELD_UNAVAILABLE",
          stance: "INSUFFICIENT",
          facts: [],
          primaryMeasure: "TREND",
          note: "INSUFFICIENT because rank velocity was not returned",
        };
      const facts = compact(
        recent.map((p) =>
          fact(
            ok.raw,
            "Population rank velocity",
            `/series/0/points/${p.index}/population_rank_velocity`,
            "TREND",
          ),
        ),
      );
      const rising = recent.filter((p) => (p.v as number) > 0).length;
      if (rising > recent.length / 2)
        return {
          ...b,
          stance: "SUPPORTS",
          facts,
          primaryMeasure: "TREND",
          note: `SUPPORTS because the rank velocity is positive in ${rising} of the latest ${recent.length} points`,
        };
      return {
        ...b,
        stance: "NEUTRAL",
        facts,
        primaryMeasure: "TREND",
        note: `NEUTRAL because the rank velocity is positive in only ${rising} of the latest ${recent.length} points`,
      };
    }
    case "AUDIENCE_PROFILE": {
      // Descriptive only: relative indices in [−1, 1], never shares of people, never used to target.
      const facts = compact([
        fact(
          ok.raw,
          "Aggregate audience age indices (relative, not shares of people)",
          "/results/0/query/age",
          "DEMOGRAPHIC_INDEX",
        ),
      ]);
      return {
        ...b,
        stance: "NEUTRAL",
        facts,
        primaryMeasure: "DEMOGRAPHIC_INDEX",
        note: "NEUTRAL: an aggregate audience profile is descriptive and never decides a claim",
      };
    }
  }
}
