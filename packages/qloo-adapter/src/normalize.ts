import { isLegacyType, isObj, num, str } from "./envelope";
import type {
  AudienceComparison,
  ComparisonTag,
  DemographicFact,
  GeoPopularity,
  NormalizedEntity,
  NormalizedTag,
  TrendSeries,
} from "./types";

// Mapping per API_CONTRACTS §6.2 (V1-observed). Only fields actually present are copied;
// absent expected fields are listed in `missingFields`. Nothing is defaulted or invented.

type Obj = Record<string, unknown>;
const items = (payload: unknown, key = "results"): Obj[] => {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload) && Array.isArray(payload[key]))
    return (payload[key] as unknown[]).filter(isObj);
  return [];
};

function entity(
  raw: Obj,
  type: string | undefined,
  expected: (keyof NormalizedEntity)[],
): NormalizedEntity | null {
  const qlooId = str(raw.entity_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!qlooId || !name) return null;
  const properties = isObj(raw.properties) ? raw.properties : undefined;
  const result: NormalizedEntity = {
    qlooId,
    name,
    type,
    legacyType: isLegacyType(type),
    popularity: num(raw.popularity),
    affinity: num(raw.affinity),
    disambiguation: str(raw.disambiguation),
    description: str(properties?.description),
    properties,
    explainability: raw.explainability,
    missingFields: [],
  };
  if (Array.isArray(raw.tags)) {
    result.tags = raw.tags.filter(isObj).flatMap((t) => {
      const tagId = str(t.tag_id) ?? str(t.id);
      const tagName = str(t.name);
      return tagId && tagName
        ? [{ tagId, name: tagName, type: str(t.type) }]
        : [];
    });
  }
  result.missingFields = expected.filter(
    (field) => result[field] === undefined,
  );
  return result;
}

/** `qloo api search`: top-level array of entities with types[], disambiguation, and tags. */
export function normalizeSearch(payload: unknown): NormalizedEntity[] {
  return items(payload).flatMap((raw) => {
    const types = Array.isArray(raw.types)
      ? raw.types.filter((t): t is string => typeof t === "string")
      : [];
    const e = entity(raw, types[0], ["type", "popularity"]);
    return e ? [e] : [];
  });
}

/** describe: results carry no type; it comes from the resolution's selected entity. */
export function normalizeDescribe(
  payload: unknown,
  selectedType?: string,
): NormalizedEntity[] {
  return items(payload).flatMap((raw) => {
    const e = entity(raw, selectedType, ["type", "popularity"]);
    return e ? [e] : [];
  });
}

/** recommend / rank: `type` is the generic "urn:entity"; the category is in `subtype`. */
export function normalizeRanked(payload: unknown): NormalizedEntity[] {
  return items(payload).flatMap((raw) => {
    const type =
      str(raw.subtype) ??
      (str(raw.type) !== "urn:entity" ? str(raw.type) : undefined);
    const e = entity(raw, type, ["type", "popularity", "affinity"]);
    return e ? [e] : [];
  });
}

export function normalizeTags(payload: unknown): NormalizedTag[] {
  return items(payload).flatMap((raw) => {
    const tagId = str(raw.id) ?? str(raw.tag_id);
    const name = str(raw.name);
    if (!tagId || !name) return [];
    return [
      {
        tagId,
        name,
        tagType: str(raw.type),
        popularity: num(raw.popularity),
        affinity: num(raw.affinity),
      },
    ];
  });
}

function comparisonTag(raw: Obj): ComparisonTag | null {
  const tagId = str(raw.tag_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!tagId || !name) return null;
  const query = isObj(raw.query) ? raw.query : {};
  const count =
    num(query.count) ??
    (typeof query.count === "string" && query.count.trim() !== ""
      ? Number(query.count)
      : undefined);
  return {
    tagId,
    name,
    subtype: str(raw.subtype),
    entityId: str(raw.entity_id),
    popularity: num(raw.popularity),
    count: count !== undefined && Number.isFinite(count) ? count : undefined,
  };
}

/** compare_audiences returns tag profiles and overlap lists; no similarity score exists or is derived. */
export function normalizeComparison(payload: unknown): AudienceComparison {
  const results =
    isObj(payload) && isObj(payload.results) ? payload.results : {};
  const list = (key: string) =>
    (Array.isArray(results[key]) ? (results[key] as unknown[]) : [])
      .filter(isObj)
      .map(comparisonTag)
      .filter((t): t is ComparisonTag => t !== null);
  return {
    shared: list("tags"),
    a: list("a"),
    b: list("b"),
    matchEntities: Array.isArray(results.matchEntities)
      ? results.matchEntities
      : [],
  };
}

export function normalizeGeo(payload: unknown): GeoPopularity[] {
  return items(payload).flatMap((raw) => {
    const location = isObj(raw.location) ? raw.location : {};
    const query = isObj(raw.query) ? raw.query : {};
    const latitude = num(location.latitude);
    const longitude = num(location.longitude);
    if (latitude === undefined || longitude === undefined) return [];
    return [
      {
        latitude,
        longitude,
        geohash: str(location.geohash),
        affinity: num(query.affinity),
        affinityRank: num(query.affinity_rank),
        popularity: num(query.popularity),
      },
    ];
  });
}

export function normalizeDemographics(payload: unknown): DemographicFact[] {
  return items(payload).flatMap((raw) => {
    const query = isObj(raw.query) ? raw.query : {};
    const facts: DemographicFact[] = [];
    for (const dimension of ["age", "gender"] as const) {
      const bands = isObj(query[dimension]) ? (query[dimension] as Obj) : {};
      for (const [band, value] of Object.entries(bands)) {
        const index = num(value);
        if (index !== undefined)
          facts.push({ entityId: str(raw.entity_id), dimension, band, index });
      }
    }
    return facts;
  });
}

export function normalizeTrends(payload: unknown): TrendSeries[] {
  return items(payload, "series").map((series) => {
    const entityInfo = isObj(series.entity) ? series.entity : {};
    const points = (Array.isArray(series.points) ? series.points : [])
      .filter(isObj)
      .flatMap((p) => {
        const date = str(p.date);
        if (!date) return [];
        const rankRaw =
          typeof p.population_rank === "string" ? p.population_rank : undefined;
        const rank =
          num(p.population_rank) ??
          (rankRaw !== undefined && /^\d+$/.test(rankRaw)
            ? Number(rankRaw)
            : undefined);
        return [
          {
            date,
            populationPercentile: num(p.population_percentile),
            populationRank: rank,
            populationRankRaw: rankRaw,
            rankVelocity: num(p.population_rank_velocity),
            velocityFoldChange: num(p.velocity_fold_change),
            percentDelta: num(p.population_percent_delta),
          },
        ];
      });
    return {
      entityId: str(entityInfo.entityId) ?? str(entityInfo.entity_id),
      name: str(entityInfo.name),
      points,
    };
  });
}
