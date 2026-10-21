import { sha256Hex } from "@tessaloom/core";
import type { HarnessCall, HarnessTransport, RawHarnessResult } from "../types";

/**
 * Deterministic **synthetic** fixtures for local development and browser E2E (ADR-024).
 * Every name is fictional ("Amber Atlas"), every ID starts with `FX-`, and the transport is
 * named FIXTURE, so every record it produces is DEVELOPMENT_FIXTURE and shown under the
 * FIXTURE banner. It answers any request (interactive E2E journeys change requests), but it
 * is never used for live operations and refuses to exist in production.
 *
 * It mirrors the V1-observed contract and quirks (ADR-019): describe → resolution outcomes;
 * single-word names are ambiguous; localities come back as same-named candidates without
 * disambiguation, which `api search` provides; recommend puts the category in `subtype`;
 * compare_audiences returns tag profiles without a score; trends is empty outside
 * movie/tv_show.
 */
export const SYNTHETIC_LABEL = "SYNTHETIC DEVELOPMENT FIXTURE — NOT QLOO DATA";

const ADJECTIVES = [
  "Amber",
  "Velvet",
  "Paper",
  "Midnight",
  "Copper",
  "Lantern",
  "Glass",
  "Salt",
  "Neon",
  "Moss",
  "Harbor",
  "Quiet",
  "Ember",
  "Silver",
  "Tidal",
  "Juniper",
  "Cobalt",
  "Willow",
  "Saffron",
  "Indigo",
  "Linen",
  "Orchard",
  "Granite",
  "Clover",
];
const NOUNS: Record<string, string[]> = {
  book: ["Atlas", "Almanac", "Chronicle", "Letters", "Garden", "Archive"],
  movie: ["Reel", "Signal", "Horizon", "Matinee", "Frame", "Nocturne"],
  tv_show: [
    "Season",
    "Bureau",
    "Station",
    "Precinct",
    "Parlor",
    "Harbor Files",
  ],
  artist: ["Collective", "Ensemble", "Duo", "Quartet", "Choir", "Orchestra"],
  podcast: ["Hour", "Dispatch", "Notebook", "Radio", "Tapes", "Salon"],
  videogame: ["Quest", "Odyssey", "Farm", "Tactics", "Island", "Workshop"],
  place: ["Café", "Hall", "Market", "Gallery", "Courtyard", "Bookshop"],
  brand: ["Roasters", "Supply Co.", "Studio", "Atelier", "Works", "Provisions"],
  person: ["Ada", "Ines", "Tomas", "Mira", "Kofi", "Lena"],
  destination: ["Coast", "Valley", "Old Town", "Isles", "Quarter", "Heights"],
};
const TAGS: { slug: string; name: string; type: string }[] = [
  ["noir", "noir", "genre:media"],
  ["synth", "synthesizer", "keyword:media"],
  ["rain", "rainy nights", "keyword:media"],
  ["cozy", "cozy", "subgenre:qloo"],
  ["retro", "retro futurism", "style:qloo"],
  ["jazz", "late-night jazz", "genre:media"],
  ["folk", "folk tales", "plot:qloo"],
  ["tea", "tea culture", "interests:qloo"],
  ["comedy", "gentle comedy", "genre:media"],
  ["mystery", "mystery", "genre:media"],
  ["dance", "dance floor", "keyword:media"],
  ["craft", "handmade craft", "interests:qloo"],
  ["city", "city at night", "keyword:media"],
  ["sea", "seaside", "keyword:media"],
  ["memory", "memory", "motif:qloo"],
  ["award", "prize winner", "endorsement:qloo"],
  ["coffee", "specialty coffee", "interests:qloo"],
  ["games", "board games", "interests:qloo"],
].map(([slug, name, type]) => ({ slug: slug!, name: name!, type: type! }));
const CATALOG_SIZE = 24;

function rng(seed: string) {
  let h = parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = <T>(items: T[], seed: string) => {
  const r = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};
const hash6 = (s: string) => sha256Hex(s).slice(0, 6);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function catalogItem(type: string, i: number) {
  const nouns = NOUNS[type] ?? NOUNS.book!;
  const name =
    type === "person"
      ? `${nouns[i % nouns.length]} ${ADJECTIVES[(i * 7) % ADJECTIVES.length]}`
      : `${ADJECTIVES[i % ADJECTIVES.length]} ${nouns[(i * 5) % nouns.length]}`;
  return { id: `FX-${type}-${String(i).padStart(2, "0")}`, name };
}
const typeOfId = (id: string) => /^FX-([a-z_]+)-/.exec(id)?.[1] ?? "book";

const envelope = (
  operation: string,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
) => ({
  schema_version: "1.0-preview.1",
  operation,
  status: "ok",
  ...body,
  provenance: {
    source: "Synthetic fixture",
    endpoint: "/v2/insights",
    requests: [{ method: "GET", path: "/v2/insights", query }],
  },
  execution: {
    transport: "synthetic",
    transport_name: SYNTHETIC_LABEL,
    correlation_id: `fx-${hash6(JSON.stringify(query))}`,
    duration_ms: 1,
  },
});

function entityTags(id: string, limit: number) {
  return shuffled(TAGS, `tags:${id}`)
    .slice(0, Math.min(limit, 6))
    .map((t, i) => ({
      id: `urn:tag:${t.type}:${t.slug}`,
      name: t.name,
      type: `urn:tag:${t.type}`,
      popularity: Number((0.9 - i * 0.07).toFixed(2)),
      affinity: Number((0.95 - i * 0.06).toFixed(2)),
    }));
}

function resolveName(input: string, type: string | undefined) {
  if (type === "locality") {
    // V1 LC-13: several same-named localities, no disambiguation in describe.
    return {
      status: "needs_input",
      summary: "Choose the intended locality.",
      results: [],
      resolution: {
        issues: [
          {
            input,
            kind: "ambiguous",
            input_kind: "entity",
            field: "entity",
            candidates: [0, 1, 2].map((n) => ({
              id: `FX-locality-${hash6(input)}${n}`,
              name: input,
              type: "urn:entity:locality",
              popularity: Number((0.9 - n * 0.2).toFixed(2)),
            })),
            provenance: {
              strategy: "exact_name_context_or_choice",
              endpoint: "/search",
            },
          },
        ],
      },
    };
  }
  if (!type) {
    // V1 LC-14: an untyped name spans several types.
    const types = shuffled(
      ["artist", "book", "movie", "person", "tv_show"],
      `types:${input}`,
    ).slice(0, 3);
    return {
      status: "needs_input",
      summary: "Choose the intended Qloo entity.",
      results: [],
      resolution: {
        issues: [
          {
            input,
            kind: "ambiguous",
            input_kind: "entity",
            field: "entity",
            candidates: types.map((t, n) => ({
              id: `FX-${t}-${hash6(input)}`,
              name: n === 0 ? input : `${input} (${t.replace("_", " ")})`,
              type: `urn:entity:${t}`,
              popularity: Number((0.8 - n * 0.15).toFixed(2)),
            })),
            provenance: {
              strategy: "exact_name_context_or_choice",
              endpoint: "/search",
            },
          },
        ],
      },
    };
  }
  const id = `FX-${type}-${hash6(input)}`;
  // Single-word names are ambiguous: an exact pick plus alternatives (V1 finding 1).
  const alternatives =
    words(input).length === 1
      ? [
          {
            id: `FX-${type}-${hash6(`${input}-collected`)}`,
            name: `${input} (Collected Edition)`,
            type: `urn:entity:${type}`,
            popularity: 0.95,
            description: "Synthetic alternative",
          },
          {
            id: `FX-${type}-${hash6(`${input}-live`)}`,
            name: `${input} Live`,
            type: `urn:entity:${type}`,
            popularity: 0.4,
          },
        ]
      : [];
  return {
    status: "ok",
    results: [
      {
        entity_id: id,
        name: input,
        popularity: 0.72,
        properties: {
          description: `Synthetic ${type.replace("_", " ")} for development`,
        },
      },
    ],
    result_count: 1,
    resolution: {
      outcomes: [
        {
          input,
          status: "resolved",
          match: "exact",
          selected: {
            id,
            name: input,
            type: `urn:entity:${type}`,
            popularity: 0.72,
            description: `Synthetic ${type}`,
          },
          alternatives,
          provenance: {
            provider_id: "synthetic",
            strategy: "exact_name_context_or_choice",
            endpoint: "/search",
            uses_model: false,
          },
        },
      ],
    },
  };
}

function search(query: string, type: string | undefined, take: number) {
  if (type === "locality")
    return [0, 1, 2].slice(0, take).map((n) => ({
      entity_id: `FX-locality-${hash6(query)}${n}`,
      name: query,
      types: ["urn:entity:locality"],
      popularity: Number((0.9 - n * 0.2).toFixed(2)),
      disambiguation: [
        `${query}, Fictional Province, Testland`,
        `${query}, North Shire, Mockovia`,
        `${query}, Riverside County, Exampleton`,
      ][n],
      properties: { population: 50_000 * (3 - n) },
    }));
  const t = type ?? "book";
  return [0, 1, 2, 3].slice(0, take).map((n) => ({
    entity_id:
      n === 0 ? `FX-${t}-${hash6(query)}` : `FX-${t}-${hash6(`${query}-${n}`)}`,
    name:
      n === 0
        ? query
        : `${query} ${["Revisited", "Anthology", "Companion"][n - 1]}`,
    types: [`urn:entity:${t}`],
    popularity: Number((0.8 - n * 0.15).toFixed(2)),
    disambiguation:
      n === 0 ? undefined : `Synthetic ${t} related to "${query}"`,
    tags: entityTags(`FX-${t}-${hash6(query)}${n}`, 4).map((x) => ({
      tag_id: x.id,
      name: x.name,
      type: x.type,
    })),
  }));
}

function ranked(type: string, ids: string[]) {
  return ids.map((id, i) => {
    const item = /^FX-[a-z_]+-\d\d$/.test(id)
      ? catalogItem(typeOfId(id), Number(id.slice(-2)))
      : { id, name: `Option ${hash6(id)}` };
    return {
      entity_id: id,
      name: item.name,
      type: "urn:entity",
      subtype: `urn:entity:${type}`,
      popularity: Number((0.4 + ((i * 37) % 50) / 100).toFixed(2)),
      affinity: Number((0.96 - i * 0.021).toFixed(3)),
    };
  });
}

export function syntheticPayload(call: HarnessCall): unknown {
  const a = call.args as Record<string, unknown>;
  if (call.kind === "search")
    return search(
      String(a.query),
      a.type as string | undefined,
      Number(a.take ?? 5),
    );
  switch (call.workflow) {
    case "describe":
      return {
        schema_version: "1.0-preview.1",
        operation: "describe",
        ...resolveName(String(a.entity), a.type as string | undefined),
        execution: {
          transport: "synthetic",
          correlation_id: `fx-${hash6(String(a.entity))}`,
          duration_ms: 1,
        },
      };
    case "find_tags": {
      const q = String(a.query);
      const kinds = ["keyword:media", "genre:media", "subgenre:qloo"].slice(
        0,
        Math.min(3, Number(a.limit ?? 3)),
      );
      return envelope(
        "find_tags",
        {
          results: kinds.map((k, i) => ({
            id: `urn:tag:${k}:${slug(q)}`,
            name:
              i === 0
                ? q.toLowerCase()
                : `${q.toLowerCase()} (${k.split(":")[0]})`,
            type: `urn:tag:${k}`,
            popularity: Number((0.7 - i * 0.1).toFixed(2)),
          })),
          result_count: kinds.length,
        },
        a,
      );
    }
    case "entity_tags": {
      const entities = (a.entities as string[]) ?? [];
      const results = entityTags(entities.join(","), Number(a.limit ?? 10));
      return envelope(
        "entity_tags",
        { results, result_count: results.length },
        a,
      );
    }
    case "recommend": {
      const type = String(a.target_type);
      const signals = [
        ...((a.signals as string[]) ?? []),
        ...((a.signal_tags as string[]) ?? []),
      ];
      const limit = Number(a.limit ?? 10);
      // Each signal's affinity list draws from one shared catalog, so different seeds'
      // threads overlap (co-occurrence bridges) the way real cross-domain results can.
      const catalog = Array.from(
        { length: CATALOG_SIZE },
        (_, i) => catalogItem(type, i).id,
      );
      const order = shuffled(
        catalog,
        `rec:${type}:${[...signals].sort().join(",")}`,
      );
      return envelope(
        "recommend",
        {
          results: ranked(type, order.slice(0, limit)),
          result_count: Math.min(limit, order.length),
        },
        a,
      );
    }
    case "rank": {
      const options = shuffled(
        (a.options as string[]) ?? [],
        `rank:${String(a.signals)}`,
      );
      return envelope(
        "rank",
        {
          results: ranked(String(a.option_type), options),
          result_count: options.length,
        },
        a,
      );
    }
    case "compare_audiences": {
      const r = rng(`cmp:${String(a.group_a)}:${String(a.group_b)}`);
      const profile = (seed: string) =>
        shuffled(TAGS, seed)
          .slice(0, 5)
          .map((t) => ({
            tag_id: `urn:tag:${t.type}:${t.slug}`,
            name: t.name,
            type: "urn:tag",
            subtype: `urn:tag:${t.type}`,
            popularity: 0.5,
            query: { count: 10 },
          }));
      const shared =
        r() < 0.5 ? profile(`shared:${String(a.group_a)}`).slice(0, 2) : [];
      return envelope(
        "compare_audiences",
        {
          results: {
            tags: shared,
            a: profile(`a:${String(a.group_a)}`),
            b: profile(`b:${String(a.group_b)}`),
            matchEntities: [],
          },
        },
        a,
      );
    }
    case "where_popular": {
      const r = rng(`geo:${String(a.entity)}:${String(a.within)}`);
      const cells = Array.from({ length: 5 }, (_, i) => ({
        location: {
          latitude: 38.7 + r() / 10,
          longitude: -9.1 + r() / 10,
          geohash: `fx${hash6(String(i))}`,
        },
        query: {
          affinity: Number((0.92 - i * 0.12).toFixed(2)),
          affinity_rank: i + 1,
          popularity: 0.5,
        },
      }));
      return envelope(
        "where_popular",
        { results: cells, result_count: cells.length },
        a,
      );
    }
    case "trends": {
      const type = String(a.entity_type);
      const entities = (a.entities as string[]) ?? [];
      const series = entities.map((id) => {
        const r = rng(`trend:${id}`);
        const up = r() < 0.6;
        const points =
          type === "movie" || type === "tv_show"
            ? Array.from({ length: 6 }, (_, i) => ({
                date: `2026-0${(i % 9) + 1}-01`,
                population_percentile: 0.5,
                population_rank: 100 - i,
                population_rank_velocity: up ? 1 + i : -1 - i,
                velocity_fold_change: up ? 1.1 + i / 10 : 0.8,
              }))
            : [];
        return {
          entity: { entity_id: id, name: catalogItem(typeOfId(id), 0).name },
          points,
        };
      });
      return envelope("trends", { series, result_count: series.length }, a);
    }
    case "audience_demographics":
      return envelope(
        "audience_demographics",
        {
          results: [
            {
              entity_id: String(a.entity),
              query: {
                age: {
                  "24_and_younger": 0.12,
                  "25_to_29": 0.31,
                  "30_to_34": 0.08,
                  "35_to_44": -0.05,
                  "45_to_54": -0.18,
                  "55_and_older": -0.3,
                },
                gender: { male: -0.04, female: 0.04 },
              },
            },
          ],
          result_count: 1,
        },
        a,
      );
    default:
      return envelope(call.workflow, { results: [], result_count: 0 }, a);
  }
}

export class SyntheticFixtureTransport implements HarnessTransport {
  readonly name = "FIXTURE" as const;
  calls = 0;

  constructor(appEnv: string) {
    if (appEnv === "production")
      throw new Error(
        "SyntheticFixtureTransport cannot be constructed in production",
      );
  }

  async call(call: HarnessCall): Promise<RawHarnessResult> {
    this.calls++;
    return {
      payload: syntheticPayload(call),
      exitCode: 0,
      durationMs: 1,
      transport: this.name,
    };
  }
}
