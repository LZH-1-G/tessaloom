import { describe, expect, it } from "vitest";
import {
  llmStats,
  sequenceGaps,
  stateSpans,
  toolStats,
} from "../../apps/web/src/lib/activity";
import { layoutGraph, neighbor } from "../../apps/web/src/lib/graph-layout";
import type { RunEventView } from "../../apps/web/src/lib/types";
import {
  buildEvidenceGraph,
  claimEntityIds,
  type GraphSource,
} from "../../packages/core/src";
import { schema } from "../../packages/db/src";
import { AnthropicProvider } from "../../packages/llm-gateway/src";

const E = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Two hypotheses, one retired; three claims; evidence with one superseded record. */
function source(): GraphSource {
  return {
    seeds: [
      { entityId: E(1), role: "seed" },
      { entityId: E(2), role: "seed" },
      { entityId: E(9), role: "location" },
    ],
    entities: [
      [1, "Paper Atlas Stories", "book", "entity"],
      [2, "Neon Harbor Nights", "movie", "entity"],
      [3, "Moss Gallery", "place", "entity"],
      [4, "cozy", "tag", "tag"],
      [9, "Lisbon", "locality", "locality"],
    ].map(([n, name, domain, kind]) => ({
      id: E(n as number),
      kind: kind as string,
      name: name as string,
      domain: domain as string,
      provenanceClass: "DEVELOPMENT_FIXTURE",
      sourceToolInvocationId: E(100 + (n as number)),
    })),
    relations: [
      {
        id: E(50),
        kind: "THREAD",
        fromEntityId: E(1),
        toEntityId: E(3),
        provenanceClass: "DEVELOPMENT_FIXTURE",
      },
    ],
    hypotheses: [
      {
        id: E(10),
        title: "Atlas × Gallery",
        status: "PARTIALLY_SUPPORTED",
        retired: false,
        revisionOfId: E(11),
        iteration: 1,
        compositeScore: 72,
        elements: [
          { entityId: E(1), role: "anchor" },
          { entityId: E(3), role: "anchor" },
        ],
        claims: [
          {
            id: E(20),
            ordinal: 0,
            statement: "Fans of the book favor the gallery",
            testKind: "CROSS_DOMAIN_AFFINITY",
            status: "TESTED",
            currentStance: "SUPPORTS",
            testParams: {
              signalEntityIds: [E(1)],
              targetDomain: "place",
              targetEntityId: E(3),
            },
          },
          {
            id: E(21),
            ordinal: 1,
            statement: "The gallery carries the cozy theme",
            testKind: "TAG_RESONANCE",
            status: "PLANNED",
            currentStance: null,
            testParams: { signalEntityIds: [E(3)], tagEntityIds: [E(4)] },
          },
        ],
        evidence: [
          {
            id: E(30),
            claimId: E(20),
            stance: "NEUTRAL",
            evaluatorId: "CROSS_DOMAIN_AFFINITY@r",
            provenanceClass: "DEVELOPMENT_FIXTURE",
            toolInvocationId: E(200),
            quality: "FULL",
          },
          {
            id: E(31),
            claimId: E(20),
            stance: "SUPPORTS",
            evaluatorId: "CROSS_DOMAIN_AFFINITY@r",
            provenanceClass: "DEVELOPMENT_FIXTURE",
            toolInvocationId: E(201),
            quality: "FULL",
          },
        ],
      },
      {
        id: E(11),
        title: "Atlas × Gallery (first draft)",
        status: "INCONCLUSIVE",
        retired: true,
        revisionOfId: null,
        iteration: 0,
        compositeScore: 50,
        elements: [{ entityId: E(1), role: "anchor" }],
        claims: [
          {
            id: E(22),
            ordinal: 0,
            statement: "Old claim",
            testKind: "AUDIENCE_PROFILE",
            status: "TESTED",
            currentStance: "NEUTRAL",
            testParams: { signalEntityIds: [E(1)] },
          },
        ],
        evidence: [],
      },
    ],
  };
}

describe("evidence graph projection (EG, core/graph)", () => {
  it("projects only stored records, each with a provenance class", () => {
    const g = buildEvidenceGraph(source());
    const types = g.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "hypothesis")).toHaveLength(1); // retired hidden by default
    expect(types.filter((t) => t === "claim")).toHaveLength(2);
    expect(types.filter((t) => t === "evidence")).toHaveLength(2);
    for (const n of g.nodes) expect(n.provenance).toBeTruthy();
    for (const e of g.edges) {
      expect(e.provenance).toBeTruthy();
      expect(g.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(g.nodes.some((n) => n.id === e.target)).toBe(true);
    }
  });

  it("labels AI output as interpretation/speculation and keeps Qloo/fixture labels on data", () => {
    const g = buildEvidenceGraph(source());
    const by = new Map(g.nodes.map((n) => [n.id, n]));
    expect(by.get(E(10))!.provenance).toBe("CREATIVE_SPECULATION");
    expect(by.get(E(20))!.provenance).toBe("MODEL_INTERPRETATION");
    expect(by.get(E(31))!.provenance).toBe("DEVELOPMENT_FIXTURE");
    expect(by.get(E(1))!.provenance).toBe("DEVELOPMENT_FIXTURE");
    // Trace targets exist for data-backed nodes only (EG-A3).
    expect(by.get(E(31))!.invocationId).toBe(E(201));
    expect(by.get(E(10))!.invocationId).toBeNull();
    expect(by.get(E(20))!.invocationId).toBeNull();
  });

  it("cites only from the latest evidence record and links revisions when retired are included", () => {
    const g = buildEvidenceGraph(source(), { includeRetired: true });
    const cites = g.edges.filter((e) => e.kind === "CITES");
    expect(new Set(cites.map((e) => e.source))).toEqual(new Set([E(31)]));
    expect(cites.map((e) => e.target).sort()).toEqual([E(1), E(3)].sort());
    expect(g.edges.some((e) => e.kind === "REVISION_OF")).toBe(true);
    expect(g.nodes.find((n) => n.id === E(11))!.data.retired).toBe(true);
  });

  it("adds discovery threads only on request, and is deterministic", () => {
    const a = buildEvidenceGraph(source(), { includeThreads: true });
    const b = buildEvidenceGraph(source(), { includeThreads: true });
    expect(a).toEqual(b);
    expect(a.edges.some((e) => e.kind === "THREAD")).toBe(true);
    expect(
      claimEntityIds({ signalEntityIds: [E(1)], targetEntityId: E(1) }),
    ).toEqual([E(1)]);
  });
});

describe("graph layout and keyboard navigation", () => {
  it("lays out columns left to right and honours saved positions", () => {
    const g = buildEvidenceGraph(source());
    const pos = layoutGraph(g);
    expect(pos.size).toBe(g.nodes.length);
    expect(pos.get(E(1))!.x).toBeLessThan(pos.get(E(10))!.x);
    expect(pos.get(E(10))!.x).toBeLessThan(pos.get(E(20))!.x);
    expect(pos.get(E(20))!.x).toBeLessThan(pos.get(E(31))!.x);
    const saved = layoutGraph(g, { [E(10)]: { x: 5, y: 6 } });
    expect(saved.get(E(10))).toEqual({ x: 5, y: 6 });
    const ys = [...pos.values()].filter((p) => p.x === 0).map((p) => p.y);
    expect(new Set(ys).size).toBe(ys.length); // entities never overlap
  });

  it("arrows follow connections and move within a column", () => {
    const g = buildEvidenceGraph(source());
    const pos = layoutGraph(g);
    const all = new Set(g.nodes.map((n) => n.id));
    expect(neighbor(g, pos, E(10), "ArrowRight", all)).toBe(E(20));
    expect(neighbor(g, pos, E(20), "ArrowLeft", all)).toBe(E(10));
    expect(neighbor(g, pos, E(20), "ArrowDown", all)).toBe(E(21));
    expect(neighbor(g, pos, E(21), "ArrowDown", all)).toBeNull();
    const hidden = new Set([...all].filter((id) => id !== E(20)));
    expect(neighbor(g, pos, E(10), "ArrowRight", hidden)).toBe(E(21));
  });
});

const ev = (
  seq: number,
  type: string,
  state: string,
  ts: number,
  payload: Record<string, unknown> = {},
  role: string | null = null,
): RunEventView => ({
  seq,
  ts: new Date(ts).toISOString(),
  type,
  state,
  role,
  summary: type,
  payload,
});

describe("activity monitor statistics", () => {
  const events = [
    ev(1, "STATE_ENTERED", "ANALYZING_INTENT", 0),
    ev(
      2,
      "LLM_CALL_FINISHED",
      "ANALYZING_INTENT",
      500,
      {
        promptId: "r1.intent",
        modelId: "scripted-demo",
        attempts: 2,
        outputTokens: 120,
        costUsd: 0,
      },
      "R1",
    ),
    ev(3, "STATE_ENTERED", "AWAITING_BRIEF_CONFIRMATION", 1000),
    ev(4, "STATE_ENTERED", "COLLECTING_EVIDENCE", 61_000),
    ev(5, "TOOL_CALL_FINISHED", "COLLECTING_EVIDENCE", 61_500, {
      method: "recommend",
      outcome: "OK",
      resultCount: 20,
      dataOrigin: "FIXTURE",
    }),
    ev(7, "TOOL_CALL_FINISHED", "COLLECTING_EVIDENCE", 62_000, {
      method: "recommend",
      outcome: "ERROR",
      resultCount: 0,
      dataOrigin: null,
    }),
  ];

  it("computes state spans with paused gates marked", () => {
    const spans = stateSpans(events, 64_000);
    expect(spans.map((s) => [s.state, s.endMs - s.startMs, s.paused])).toEqual([
      ["ANALYZING_INTENT", 1000, false],
      ["AWAITING_BRIEF_CONFIRMATION", 60_000, true],
      ["COLLECTING_EVIDENCE", 3000, false],
    ]);
  });

  it("aggregates Qloo calls and LLM cost from event payloads", () => {
    expect(toolStats(events)).toEqual([
      {
        method: "recommend",
        calls: 2,
        ok: 1,
        failed: 1,
        results: 20,
        origins: { FIXTURE: 1, none: 1 },
      },
    ]);
    expect(llmStats(events)[0]).toMatchObject({
      promptId: "r1.intent",
      attempts: 2,
      costUsd: 0,
      role: "R1",
    });
  });

  it("detects sequence gaps (AM-A2)", () => {
    expect(sequenceGaps(events)).toEqual([6]);
    expect(sequenceGaps(events.slice(0, 5))).toEqual([]);
  });
});

describe("AM-A3: no chain-of-thought is stored or shown", () => {
  it("has no reasoning or thinking columns in the LLM and event tables", () => {
    for (const table of [schema.llmInvocations, schema.runEvents]) {
      // Drizzle exposes each column as a property carrying its SQL name.
      const names = Object.values(table)
        .filter(
          (c): c is { name: string; columnType: string } =>
            !!c && typeof c === "object" && "columnType" in c,
        )
        .map((c) => c.name);
      expect(names.length).toBeGreaterThan(5);
      expect(
        names.filter((n) => /think|reasoning|chain|thought/i.test(n)),
      ).toEqual([]);
    }
  });

  it("drops thinking blocks from provider output", async () => {
    const message = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "PRIVATE-REASONING", signature: "s" },
        { type: "text", text: '{"ok":true}' },
      ],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = new AnthropicProvider({
      client: {
        beta: {
          messages: {
            create: async () => message as never,
            stream: () => ({ finalMessage: async () => message as never }),
          },
        },
      },
    });
    const out = await provider.generate({
      promptId: "r1.intent",
      model: "claude-opus-5-5",
      system: "S",
      messages: [{ role: "user", content: "U" }],
      jsonSchema: {},
      effort: "low",
      maxOutputTokens: 100,
    });
    expect(JSON.stringify(out)).not.toContain("PRIVATE-REASONING");
    expect(out.text).toBe('{"ok":true}');
  });
});
