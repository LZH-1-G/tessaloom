import { describe, expect, it } from "vitest";
import { exactSingle, mergeCandidates } from "../../packages/agent/src";
import {
  QlooAdapter,
  SyntheticFixtureTransport,
  syntheticPayload,
  toHarness,
  DescribeEntityInput,
  RecommendInput,
} from "../../packages/qloo-adapter/src";

const entity = (
  qlooId: string,
  name: string,
  source: "selected" | "alternative" | "issue_candidate" | "search",
  type = "urn:entity:book",
) => ({ qlooId, name, type, legacyType: false, source, rankInSource: 0 });
const tag = (tagId: string, name: string) => ({ tagId, name, rankInSource: 0 });
const set = (
  entities: ReturnType<typeof entity>[] = [],
  tags: ReturnType<typeof tag>[] = [],
) => ({ entities, tags, provenance: [] });

describe("CI-A1: ambiguous interests are never auto-resolved", () => {
  // Ten fixture cases: only exactly one candidate whose name equals the input is accepted.
  const cases: [string, ReturnType<typeof set>, boolean][] = [
    [
      "Murder on the Orient Express",
      set([
        entity("E1", "Murder on the Orient Express", "selected"),
        entity(
          "E2",
          "Murder on the Orient Express (Poirot #10)",
          "alternative",
        ),
      ]),
      false,
    ],
    [
      "Agatha Christie",
      set([
        entity("A1", "Agatha Christie", "issue_candidate", "urn:entity:author"),
        entity("A2", "Agatha Christie", "issue_candidate", "urn:entity:person"),
      ]),
      false,
    ],
    [
      "Lisbon",
      set([
        entity("L1", "Lisbon", "issue_candidate", "urn:entity:locality"),
        entity("L2", "Lisbon", "issue_candidate", "urn:entity:locality"),
      ]),
      false,
    ],
    [
      "cozy mystery",
      set([], [tag("T1", "cozy mystery"), tag("T2", "cozy mystery (genre)")]),
      false,
    ],
    [
      "Blade Runner",
      set([entity("M1", "Blade Runner 2049", "selected", "urn:entity:movie")]),
      false,
    ], // non-exact name
    [
      "city pop",
      set(
        [entity("X1", "City Pop", "selected", "urn:entity:artist")],
        [tag("T3", "city pop")],
      ),
      false,
    ], // entity and tag
    ["Kind of Blue", set([]), false], // no candidates
    [
      "Vangelis",
      set([entity("V1", "Vangelis", "selected", "urn:entity:artist")]),
      true,
    ],
    [
      "blade runner",
      set([entity("M2", "Blade Runner", "selected", "urn:entity:movie")]),
      true,
    ], // case-insensitive exact
    ["cumbia", set([], [tag("T4", "Cumbia")]), true], // a single exact tag
  ];
  it.each(cases)("%s → auto-accept: %s", (input, candidates, accepted) => {
    expect(exactSingle(candidates, input) !== null).toBe(accepted);
  });
  it("counts exactly 0 auto-selections for the 7 ambiguous or non-exact cases", () => {
    expect(
      cases
        .filter(([, , a]) => !a)
        .filter(([input, c]) => exactSingle(c, input)).length,
    ).toBe(0);
  });
});

describe("candidate merging (V1: search adds disambiguation)", () => {
  it("dedupes by Qloo ID, keeps describe order, and fills in search disambiguation", () => {
    const merged = mergeCandidates({
      describe: set([
        entity("L1", "Lisbon", "issue_candidate", "urn:entity:locality"),
        entity("L2", "Lisbon", "issue_candidate", "urn:entity:locality"),
      ]),
      search: [
        {
          qlooId: "L2",
          name: "Lisbon",
          type: "urn:entity:locality",
          disambiguation: "Lisbon, Connecticut",
          missingFields: [],
        },
        {
          qlooId: "L3",
          name: "Lisbon",
          type: "urn:entity:locality",
          disambiguation: "Lisbon, Maine",
          missingFields: [],
        },
      ],
      tags: [
        {
          tagId: "T1",
          name: "lisbon nights",
          tagType: "urn:tag:keyword:media",
        },
      ],
    });
    expect(
      merged.entities.map((e) => [
        e.qlooId,
        e.source,
        e.disambiguation ?? null,
      ]),
    ).toEqual([
      ["L1", "issue_candidate", null],
      ["L2", "issue_candidate", "Lisbon, Connecticut"],
      ["L3", "search", "Lisbon, Maine"],
    ]);
    expect(merged.tags).toEqual([
      {
        tagId: "T1",
        name: "lisbon nights",
        tagType: "urn:tag:keyword:media",
        popularity: undefined,
        rankInSource: 0,
      },
    ]);
  });
});

describe("synthetic development fixtures", () => {
  it("are deterministic, fictional, labeled, and refused in production", async () => {
    const call = toHarness.recommend(
      RecommendInput.parse({
        targetType: "book",
        signals: ["FX-artist-01"],
        limit: 10,
      }),
    );
    expect(syntheticPayload(call)).toEqual(syntheticPayload(call));
    const payload = syntheticPayload(call) as {
      results: { entity_id: string; subtype: string; affinity: number }[];
      execution: { transport_name: string };
    };
    expect(payload.results).toHaveLength(10);
    expect(
      payload.results.every(
        (r) => r.entity_id.startsWith("FX-") && r.subtype === "urn:entity:book",
      ),
    ).toBe(true);
    expect(payload.results.map((r) => r.affinity)).toEqual(
      [...payload.results.map((r) => r.affinity)].sort((a, b) => b - a),
    );
    expect(payload.execution.transport_name).toMatch(/NOT QLOO DATA/);
    expect(() => new SyntheticFixtureTransport("production")).toThrow(
      /production/,
    );
  });

  it("mirror V1 quirks: localities and untyped names need input; single-word typed names have alternatives", async () => {
    const adapter = new QlooAdapter({
      transport: new SyntheticFixtureTransport("test"),
      harnessVersion: "fixture",
      sleep: async () => {},
    });
    const ctx = { projectId: "p", purpose: "test" };
    const locality = await adapter.describeEntity(
      { entity: "Lisbon", type: "locality" },
      ctx,
    );
    expect(locality.kind).toBe("NEEDS_INPUT");
    const untyped = await adapter.describeEntity({ entity: "Ghibli" }, ctx);
    expect(untyped.kind).toBe("NEEDS_INPUT");
    const typed = await adapter.describeEntity(
      { entity: "Vangelis", type: "artist" },
      ctx,
    );
    expect(typed.kind).toBe("OK");
    if (typed.kind === "OK") expect(typed.resolution?.entities.length).toBe(3);
    const exact = await adapter.describeEntity(
      { entity: "Stardew Harvest Tales", type: "videogame" },
      ctx,
    );
    if (exact.kind !== "OK") throw new Error("expected OK");
    expect(
      exactSingle(exact.resolution!, "Stardew Harvest Tales"),
    ).not.toBeNull();
    // Every synthetic record is FIXTURE data, never LIVE.
    expect(exact.provenance.dataOrigin).toBe("FIXTURE");
    expect(DescribeEntityInput.parse({ entity: "x" })).toEqual({ entity: "x" });
  });
});
