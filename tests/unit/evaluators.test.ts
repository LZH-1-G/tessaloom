import { describe, expect, it } from "vitest";
import {
  EVALUATION_RULESET,
  PENDING_CALIBRATION,
  assessFeasibility,
  critiqueValidator,
  evaluateClaim,
  salvageDrafts,
  type QlooResult,
} from "../../packages/agent/src";
import {
  CritiqueReport,
  uuidv7,
  type HypothesisDraft,
} from "../../packages/core/src";

const prov = {
  toolInvocationId: "inv-1",
  dataOrigin: "FIXTURE" as const,
  requestHash: "a".repeat(64),
  workflow: "recommend",
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `E${i}`);
/** A recommend envelope (V1 shape) and its normalized items, kept consistent. */
function ranked(
  n: number,
  affinity: (i: number) => number | undefined = (i) =>
    Number((0.95 - i * 0.02).toFixed(3)),
): QlooResult<unknown> {
  const results = ids(n).map((id, i) => ({
    entity_id: id,
    name: id,
    subtype: "urn:entity:book",
    ...(affinity(i) === undefined ? {} : { affinity: affinity(i) }),
  }));
  return {
    kind: "OK",
    quality: "FULL",
    provenance: prov,
    raw: { result_count: n, results },
    items: results.map((r) => ({
      qlooId: r.entity_id,
      name: r.name,
      affinity: (r as { affinity?: number }).affinity,
      missingFields: [],
    })),
  };
}

describe("CROSS_DOMAIN_AFFINITY (rank-based; V1 finding 7)", () => {
  it("SUPPORTS in the top quartile and records pointer-verified facts", () => {
    const e = evaluateClaim(
      "CROSS_DOMAIN_AFFINITY",
      { signalQlooIds: ["S"], targetQlooId: "E3" },
      ranked(20),
    );
    expect(e).toMatchObject({
      stance: "SUPPORTS",
      primaryMeasure: "RANK_POSITION",
      evaluatorId: `CROSS_DOMAIN_AFFINITY@${EVALUATION_RULESET.version}`,
    });
    expect(e.note).toBe(
      "SUPPORTS because the target ranked 4 of 20 (top quartile by aggregate affinity)",
    );
    expect(
      e.facts.map((f) => [f.jsonPointer, f.value, f.verifiedAtIngest]),
    ).toEqual([
      ["/results/3/entity_id", "E3", true],
      ["/results/3/affinity", 0.89, true],
      ["/result_count", 20, true],
    ]);
  });
  it("is NEUTRAL outside the top quartile or on tied affinities, and never uses absolute thresholds", () => {
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "E5" },
        ranked(20),
      ).stance,
    ).toBe("NEUTRAL");
    // V1-like flat but distinct affinities (0.899 … 0.883) still rank.
    const flat = ranked(8, (i) => Number((0.899 - i * 0.0023).toFixed(4)));
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "E0" },
        flat,
      ).stance,
    ).toBe("SUPPORTS");
    const tied = ranked(20, () => 0.9);
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "E0" },
        tied,
      ).note,
    ).toMatch(/effectively tied/);
  });
  it("CONTRADICTS only when absent from a full top K; otherwise absence is INSUFFICIENT", () => {
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "X" },
        ranked(20),
      ).stance,
    ).toBe("CONTRADICTS");
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "X" },
        ranked(12),
      ).stance,
    ).toBe("INSUFFICIENT");
  });
  it("marks missing affinity fields FIELD_UNAVAILABLE and domain-only claims NEUTRAL", () => {
    const missing = evaluateClaim(
      "CROSS_DOMAIN_AFFINITY",
      { signalQlooIds: ["S"], targetQlooId: "E1" },
      ranked(20, () => undefined),
    );
    expect(missing).toMatchObject({
      stance: "INSUFFICIENT",
      quality: "FIELD_UNAVAILABLE",
    });
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetDomain: "book" },
        ranked(20),
      ).stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], tagQlooIds: ["T"] },
        ranked(5),
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], tagQlooIds: ["T"] },
        ranked(2),
      ).stance,
    ).toBe("INSUFFICIENT");
  });
});

describe("other test kinds", () => {
  it("SHORTLIST_FIT grades by thirds and needs ≥ 3 options", () => {
    const r = ranked(6);
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "E1" },
        r,
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "E2" },
        r,
      ).stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "E5" },
        r,
      ).stance,
    ).toBe("CONTRADICTS");
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "E0" },
        ranked(2),
      ).stance,
    ).toBe("INSUFFICIENT");
  });
  it("AUDIENCE_BRIDGE: structural overlap SUPPORTS; otherwise INSUFFICIENT pending live calibration, never CONTRADICTS", () => {
    const cmp = (tags: unknown[]): QlooResult<unknown> => ({
      kind: "OK",
      quality: "FULL",
      provenance: prov,
      raw: { results: { tags, a: [], b: [], matchEntities: [] } },
      items: [{ shared: tags, a: [], b: [], matchEntities: [] }],
    });
    const supports = evaluateClaim(
      "AUDIENCE_BRIDGE",
      { signalQlooIds: ["A"] },
      cmp([{ tag_id: "T1" }]),
    );
    expect(supports.stance).toBe("SUPPORTS");
    expect(supports.facts[0]).toMatchObject({
      jsonPointer: "/results/tags/0/tag_id",
      value: "T1",
    });
    const none = evaluateClaim(
      "AUDIENCE_BRIDGE",
      { signalQlooIds: ["A"] },
      cmp([]),
    );
    expect(none.stance).toBe("INSUFFICIENT");
    expect(none.note).toContain(PENDING_CALIBRATION);
  });
  it("TAG_RESONANCE uses the content tag-type allowlist (V1 finding 6)", () => {
    const tags = (type: string): QlooResult<unknown> => ({
      kind: "OK",
      quality: "FULL",
      provenance: prov,
      raw: { results: [{ id: "T1", type }] },
      items: [{ tagId: "T1", name: "noir", tagType: type }],
    });
    expect(
      evaluateClaim(
        "TAG_RESONANCE",
        { signalQlooIds: ["E"], tagQlooIds: ["T1"] },
        tags("urn:tag:genre:media"),
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "TAG_RESONANCE",
        { signalQlooIds: ["E"], tagQlooIds: ["T1"] },
        tags("urn:tag:endorsement:qloo"),
      ).stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim(
        "TAG_RESONANCE",
        { signalQlooIds: ["E"], tagQlooIds: ["T9"] },
        tags("urn:tag:genre:media"),
      ).stance,
    ).toBe("NEUTRAL");
  });
  it("LOCATION_FIT is descriptive pending calibration; MOMENTUM is sign-based", () => {
    const geo: QlooResult<unknown> = {
      kind: "OK",
      quality: "FULL",
      provenance: prov,
      raw: { results: [{ query: { affinity: 0.92 } }] },
      items: [{ latitude: 1, longitude: 2, affinity: 0.92 }],
    };
    const loc = evaluateClaim("LOCATION_FIT", { signalQlooIds: ["E"] }, geo);
    expect(loc).toMatchObject({ stance: "INSUFFICIENT" });
    expect(loc.facts[0]).toMatchObject({
      jsonPointer: "/results/0/query/affinity",
      value: 0.92,
    });
    const trend = (v: number[]): QlooResult<unknown> => ({
      kind: "OK",
      quality: "FULL",
      provenance: prov,
      raw: {
        series: [
          {
            points: v.map((x) => ({ date: "d", population_rank_velocity: x })),
          },
        ],
      },
      items: [],
    });
    expect(
      evaluateClaim("MOMENTUM", { signalQlooIds: ["E"] }, trend([-1, 2, 3]))
        .stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim("MOMENTUM", { signalQlooIds: ["E"] }, trend([1, -2, -3]))
        .stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim("MOMENTUM", { signalQlooIds: ["E"] }, trend([])).stance,
    ).toBe("INSUFFICIENT");
  });
  it("maps EMPTY, ERROR, NEEDS_INPUT, and UNSUPPORTED to non-decisive outcomes with explanations", () => {
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        { kind: "EMPTY", provenance: prov, raw: {} },
      ),
    ).toMatchObject({ stance: "INSUFFICIENT", claimStatus: "TESTED" });
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        { kind: "UNSUPPORTED", reason: "trends+book" },
      ),
    ).toMatchObject({ claimStatus: "UNSUPPORTED", quality: "UNSUPPORTED" });
    const timeout = evaluateClaim(
      "MOMENTUM",
      { signalQlooIds: ["E"] },
      { kind: "ERROR", code: "TIMEOUT", retryable: true, provenance: null },
    );
    expect(timeout).toMatchObject({ claimStatus: "FAILED" });
    expect(timeout.note).toBe("Not tested — Qloo request failed (TIMEOUT)");
  });
});

describe("HL-A2: stances are deterministic", () => {
  it("the same evidence and ruleset give the same stance, facts, and rationale (100 repeats)", () => {
    const first = evaluateClaim(
      "CROSS_DOMAIN_AFFINITY",
      { signalQlooIds: ["S"], targetQlooId: "E2" },
      ranked(20),
    );
    for (let i = 0; i < 100; i++)
      expect(
        evaluateClaim(
          "CROSS_DOMAIN_AFFINITY",
          { signalQlooIds: ["S"], targetQlooId: "E2" },
          ranked(20),
        ),
      ).toEqual(first);
  });
});

describe("HL-A3: the critic cannot upgrade a stance", () => {
  it("has no stance, status, or score fields; attempted upgrades are stripped", () => {
    const h = uuidv7();
    const parsed = CritiqueReport.parse({
      perHypothesis: [
        {
          hypothesisId: h,
          citedEvidenceIds: [],
          recommendation: "keep",
          stance: "SUPPORTS",
          status: "SUPPORTED",
          compositeScore: 99,
        },
      ],
      continueLoop: false,
      decisionSummary: "x",
    });
    expect(Object.keys(parsed.perHypothesis[0]!).sort()).toEqual([
      "citedEvidenceIds",
      "hypothesisId",
      "recommendation",
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(
      /SUPPORTED|stance|compositeScore/,
    );
    // A downgrade must cite evidence; it can never raise anything.
    const issues = critiqueValidator({
      hypothesisIds: new Set([h]),
      evidenceByHypothesis: new Map([[h, new Set()]]),
    })({
      perHypothesis: [
        {
          hypothesisId: h,
          citedEvidenceIds: [],
          recommendation: "keep",
          downgrade: { reason: "thin" },
        },
      ],
      continueLoop: false,
      decisionSummary: "x",
    });
    expect(issues.map((i) => i.code)).toEqual(["MISSING_CITATION"]);
  });
});

describe("failed-repair salvage (TEST_PLAN §8)", () => {
  const [A, B, C, OUT] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const ctx = {
    entityIds: new Set([A, B, C]),
    tagIds: new Set<string>(),
    maxClaimsPerHypothesis: 3,
  };
  const draft = (over: Partial<HypothesisDraft>): HypothesisDraft => ({
    tempId: "h1",
    title: "T",
    premise: "P",
    elementRefs: [
      { entityId: A, role: "anchor" },
      { entityId: B, role: "accent" },
    ],
    claims: [
      {
        tempId: "c1",
        statement: "s",
        testKind: "CROSS_DOMAIN_AFFINITY",
        params: {
          signalEntityIds: [A],
          targetDomain: "book",
          targetEntityId: B,
        },
      },
    ],
    creativeElements: [],
    experienceSketch: "S",
    ...over,
  });
  it("drops ungrounded elements and invalid claims, keeps the rest, and reports every drop", () => {
    const report = salvageDrafts(
      [
        draft({
          elementRefs: [
            { entityId: A, role: "anchor" },
            { entityId: B, role: "accent" },
            { entityId: OUT, role: "context" },
          ],
        }),
        draft({
          tempId: "h2",
          claims: [
            {
              tempId: "c1",
              statement: "bad",
              testKind: "SHORTLIST_FIT",
              params: { signalEntityIds: [A] },
            },
          ],
        }),
        draft({
          tempId: "h3",
          elementRefs: [
            { entityId: A, role: "anchor" },
            { entityId: OUT, role: "accent" },
          ],
        }),
        draft({ tempId: "h4", premise: "Each customer will likely attend." }),
      ],
      ctx,
    );
    expect(report.kept.map((d) => [d.tempId, d.elementRefs.length])).toEqual([
      ["h1", 2],
    ]);
    expect(report.trimmed).toEqual([
      {
        tempId: "h1",
        removed: [expect.stringContaining("not in this experiment")],
      },
    ]);
    expect(report.dropped.map((d) => [d.tempId, d.reasons[0]])).toEqual([
      ["h2", "NO_VALID_CLAIMS"],
      ["h3", "FEWER_THAN_2_GROUNDED_ELEMENTS"],
      ["h4", "SAFE_USE_INDIVIDUAL_INFERENCE"],
    ]);
  });
});

describe("rule-based feasibility (S2: capacity 35, low budget, 120 minutes)", () => {
  const brief = {
    venue: { type: "cafe" as const, capacity: 35 },
    constraints: { budgetBand: "low" as const, durationMinutes: 120 },
  };
  it("penalizes formats that exceed the brief's constraints and explains every rule", () => {
    const small = assessFeasibility({
      text: "A listening corner with a short reading",
      brief,
      locationStances: [],
    });
    expect(small).toMatchObject({ score: 0.8, rules: [] });
    const big = assessFeasibility({
      text: "A weekend-long festival with a headliner and full catering",
      brief,
      locationStances: [],
    });
    expect(big.rules.map((r) => r.rule)).toEqual([
      "CAPACITY",
      "BUDGET",
      "DURATION",
    ]);
    expect(big.score).toBeCloseTo(0.1, 5);
    expect(big.rules[0]!.detail).toBe(
      "A festival usually needs ~150+ people; the venue holds 35",
    );
    const located = assessFeasibility({
      text: "A listening corner",
      brief,
      locationStances: ["SUPPORTS"],
    });
    expect(located.score).toBeCloseTo(0.9, 5);
    const unconstrained = assessFeasibility({
      text: "A festival",
      brief: { venue: { type: "cafe" }, constraints: {} },
      locationStances: [],
    });
    expect(unconstrained.rules).toEqual([]);
  });
});
