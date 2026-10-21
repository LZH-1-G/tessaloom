import { describe, expect, it } from "vitest";
import {
  EVALUATION_RULESET,
  addUsage,
  checkTermination,
  computeStatus,
  evaluateClaim,
  exhaustedLimit,
  planEvidence,
  remaining,
  scoreHypothesis,
  type ClaimState,
  type QlooResult,
} from "../../packages/agent/src";
import { DEFAULT_BUDGETS, uuidv7 } from "../../packages/core/src";

const prov = (id = "inv-1") => ({
  toolInvocationId: id,
  dataOrigin: "FIXTURE" as const,
  requestHash: "a".repeat(64),
  workflow: "recommend",
});
const ok = <T>(items: T[], raw: unknown = {}): QlooResult<T> => ({
  kind: "OK",
  items,
  quality: "FULL",
  provenance: prov(),
  raw,
});
const claim = (
  stance: ClaimState["stance"],
  inv: string | null = "i1",
  status: ClaimState["status"] = "TESTED",
): ClaimState => ({ stance, status, toolInvocationId: inv });

describe("hypothesis status (AGENT_WORKFLOW §12)", () => {
  it("applies the status table", () => {
    expect(computeStatus([claim(null, null, "PLANNED")])).toBe("SPECULATIVE");
    expect(computeStatus([claim(null, null, "PLANNED")], true)).toBe(
      "UNDER_INVESTIGATION",
    );
    expect(
      computeStatus([claim("SUPPORTS", "a"), claim("SUPPORTS", "b")]),
    ).toBe("SUPPORTED");
    // Two SUPPORTS from the same invocation are not independent evidence.
    expect(
      computeStatus([claim("SUPPORTS", "a"), claim("SUPPORTS", "a")]),
    ).toBe("PARTIALLY_SUPPORTED");
    expect(computeStatus([claim("SUPPORTS"), claim("CONTRADICTS")])).toBe(
      "PARTIALLY_SUPPORTED",
    );
    expect(computeStatus([claim("SUPPORTS"), claim("INSUFFICIENT")])).toBe(
      "PARTIALLY_SUPPORTED",
    );
    expect(
      computeStatus([
        claim("CONTRADICTS"),
        claim("CONTRADICTS"),
        claim("INSUFFICIENT"),
      ]),
    ).toBe("CONTRADICTED");
    expect(computeStatus([claim("INSUFFICIENT"), claim("INSUFFICIENT")])).toBe(
      "INCONCLUSIVE",
    );
    expect(computeStatus([claim(null, null, "FAILED")])).toBe("INCONCLUSIVE");
    expect(
      computeStatus([
        claim(null, null, "UNSUPPORTED"),
        claim(null, null, "UNSUPPORTED"),
      ]),
    ).toBe("UNTESTABLE");
  });

  it("scores support from stances and composes weighted scores in 0–100", () => {
    const weights = { support: 0.4, novelty: 0.35, feasibility: 0.25 };
    const strong = scoreHypothesis({
      claims: [claim("SUPPORTS"), claim("SUPPORTS")],
      novelty: 0.8,
      feasibility: 0.6,
      weights,
    });
    expect(strong).toMatchObject({
      support: 100,
      novelty: 80,
      feasibility: 60,
      composite: 83,
    });
    const contradicted = scoreHypothesis({
      claims: [claim("CONTRADICTS")],
      novelty: 0.8,
      feasibility: 0.6,
      weights,
    });
    expect(contradicted.support).toBe(0);
    const untested = scoreHypothesis({
      claims: [claim(null, null, "PLANNED")],
      novelty: 0.5,
      feasibility: 0.6,
      weights,
    });
    expect(untested.support).toBe(50);
  });
});

describe("termination (TEST_PLAN §4 item 4)", () => {
  const base = {
    previousStatuses: new Map(),
    newDecisiveStances: 3,
    maxIterations: 3,
  };
  it("converges when the top hypotheses are settled", () => {
    expect(
      checkTermination({
        ...base,
        iteration: 0,
        hypotheses: [
          { id: "a", status: "SUPPORTED", composite: 80 },
          { id: "b", status: "CONTRADICTED", composite: 40 },
          { id: "c", status: "SPECULATIVE", composite: 10 },
          { id: "d", status: "UNTESTABLE", composite: 50 },
        ],
      }),
    ).toEqual({ met: true, rule: "CONVERGENCE" });
    expect(
      checkTermination({
        ...base,
        iteration: 0,
        hypotheses: [
          { id: "a", status: "SUPPORTED", composite: 80 },
          { id: "b", status: "INCONCLUSIVE", composite: 70 },
        ],
      }),
    ).toEqual({ met: false, rule: null });
  });
  it("stops on diminishing returns after the first iteration", () => {
    const hypotheses = [
      { id: "a", status: "INCONCLUSIVE" as const, composite: 50 },
    ];
    const previousStatuses = new Map([["a", "INCONCLUSIVE" as const]]);
    expect(
      checkTermination({
        ...base,
        previousStatuses,
        newDecisiveStances: 1,
        iteration: 1,
        hypotheses,
      }),
    ).toEqual({ met: true, rule: "DIMINISHING_RETURNS" });
    expect(
      checkTermination({
        ...base,
        previousStatuses,
        newDecisiveStances: 2,
        iteration: 1,
        hypotheses,
      }),
    ).toEqual({ met: false, rule: null });
    expect(
      checkTermination({
        ...base,
        previousStatuses,
        newDecisiveStances: 0,
        iteration: 0,
        hypotheses,
      }),
    ).toEqual({ met: false, rule: null });
  });
  it("stops at the iteration limit", () => {
    const hypotheses = [
      { id: "a", status: "INCONCLUSIVE" as const, composite: 50 },
    ];
    expect(
      checkTermination({
        ...base,
        previousStatuses: new Map([["a", "SPECULATIVE" as const]]),
        iteration: 2,
        hypotheses,
      }),
    ).toEqual({ met: true, rule: "ITERATION_LIMIT" });
  });
});

describe("budgets (AGENT_WORKFLOW §7)", () => {
  const budget = DEFAULT_BUDGETS.EXPLORATION;
  const usage = {
    qlooCalls: 40,
    llmCalls: 3,
    llmInputTokens: 0,
    llmOutputTokens: 100,
    estimatedCostUsd: 0.5,
  };
  it("reports the exhausted limit only for resources the state needs", () => {
    expect(
      exhaustedLimit(budget, usage, 10, { llm: true, qloo: false }),
    ).toBeNull();
    expect(exhaustedLimit(budget, usage, 10, { llm: false, qloo: true })).toBe(
      "maxQlooCalls",
    );
    expect(
      exhaustedLimit(budget, usage, 421, { llm: false, qloo: false }),
    ).toBe("wallClockSeconds");
    expect(
      exhaustedLimit(budget, { ...usage, estimatedCostUsd: 2 }, 10, {
        llm: true,
        qloo: false,
      }),
    ).toBe("maxEstimatedCostUsd");
    expect(
      exhaustedLimit(budget, { ...usage, llmCalls: 14 }, 10, {
        llm: true,
        qloo: false,
      }),
    ).toBe("maxLlmCalls");
  });
  it("computes remaining and adds usage with stable precision", () => {
    expect(remaining(budget, usage, 20)).toMatchObject({
      qlooCalls: 0,
      llmCalls: 11,
      wallClockSeconds: 400,
      costUsd: 1.5,
    });
    expect(
      addUsage(usage, { estimatedCostUsd: 0.1 + 0.2, qlooCalls: 1 }),
    ).toMatchObject({ estimatedCostUsd: 0.8, qlooCalls: 41 });
  });
});

describe("deterministic evaluators (AGENT_WORKFLOW §8.2)", () => {
  const ranked = (ids: string[]) =>
    ids.map((id, i) => ({
      qlooId: id,
      name: id,
      affinity: Number((0.95 - i * 0.03).toFixed(2)),
      missingFields: [],
    }));
  const rawFor = (ids: string[]) => ({
    result_count: ids.length,
    results: ids.map((id, i) => ({
      entity_id: id,
      affinity: Number((0.95 - i * 0.03).toFixed(2)),
    })),
  });
  const twenty = Array.from({ length: 20 }, (_, i) => `E${i}`);

  it("CROSS_DOMAIN_AFFINITY: supports above median+δ, contradicts when absent from a full top K, insufficient otherwise", () => {
    const supports = evaluateClaim(
      "CROSS_DOMAIN_AFFINITY",
      { signalQlooIds: ["S"], targetQlooId: "E0" },
      ok(ranked(twenty), rawFor(twenty)),
    );
    expect(supports).toMatchObject({
      stance: "SUPPORTS",
      claimStatus: "TESTED",
      primaryMeasure: "AUDIENCE_AFFINITY",
      evaluatorId: `CROSS_DOMAIN_AFFINITY@${EVALUATION_RULESET.version}`,
    });
    expect(
      supports.facts.find((f) => f.jsonPointer === "/results/0/affinity"),
    ).toMatchObject({
      value: 0.95,
      verifiedAtIngest: true,
      measure: "AUDIENCE_AFFINITY",
    });
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "E19" },
        ok(ranked(twenty)),
      ).stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "X" },
        ok(ranked(twenty)),
      ).stance,
    ).toBe("CONTRADICTS");
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "X" },
        ok(ranked(twenty.slice(0, 5))),
      ).stance,
    ).toBe("INSUFFICIENT");
    const flat = twenty.map((id) => ({
      qlooId: id,
      name: id,
      affinity: 0.5,
      missingFields: [],
    }));
    expect(
      evaluateClaim(
        "CROSS_DOMAIN_AFFINITY",
        { signalQlooIds: ["S"], targetQlooId: "E0" },
        ok(flat),
      ).stance,
    ).toBe("INSUFFICIENT");
  });

  it("SHORTLIST_FIT: top third supports, bottom third contradicts", () => {
    const r = ok(ranked(["A", "B", "C", "D", "E", "F"]));
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "A" },
        r,
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "C" },
        r,
      ).stance,
    ).toBe("NEUTRAL");
    expect(
      evaluateClaim(
        "SHORTLIST_FIT",
        { signalQlooIds: ["S"], targetQlooId: "F" },
        r,
      ).stance,
    ).toBe("CONTRADICTS");
  });

  it("AUDIENCE_BRIDGE never contradicts; TAG_RESONANCE needs an allowed tag type", () => {
    expect(
      evaluateClaim(
        "AUDIENCE_BRIDGE",
        { signalQlooIds: ["A"] },
        ok([{ shared: [], a: [], b: [], matchEntities: [] }]),
      ).stance,
    ).toBe("INSUFFICIENT");
    expect(
      evaluateClaim(
        "AUDIENCE_BRIDGE",
        { signalQlooIds: ["A"] },
        ok([{ shared: [{ tagId: "t" }], a: [], b: [], matchEntities: [] }]),
      ).stance,
    ).toBe("SUPPORTS");
    const tags = [
      { tagId: "T1", name: "noir", tagType: "urn:tag:genre:qloo" },
      { tagId: "T2", name: "award", tagType: "urn:tag:endorsement" },
    ];
    expect(
      evaluateClaim(
        "TAG_RESONANCE",
        { signalQlooIds: ["E"], tagQlooIds: ["T1"] },
        ok(tags, { results: [{ id: "T1" }] }),
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "TAG_RESONANCE",
        { signalQlooIds: ["E"], tagQlooIds: ["T2"] },
        ok(tags),
      ).stance,
    ).toBe("NEUTRAL");
  });

  it("maps EMPTY, ERROR, NEEDS_INPUT, and UNSUPPORTED to non-decisive outcomes", () => {
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        { kind: "EMPTY", provenance: prov(), raw: {} },
      ),
    ).toMatchObject({ stance: "INSUFFICIENT", claimStatus: "TESTED" });
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        { kind: "UNSUPPORTED", reason: "trends+book" },
      ),
    ).toMatchObject({ claimStatus: "UNSUPPORTED", quality: "UNSUPPORTED" });
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        { kind: "ERROR", code: "TIMEOUT", retryable: true, provenance: null },
      ),
    ).toMatchObject({ claimStatus: "FAILED" });
    expect(
      evaluateClaim("MOMENTUM", { signalQlooIds: ["E"] }, ok([{ points: [] }]))
        .stance,
    ).toBe("INSUFFICIENT");
    expect(
      evaluateClaim(
        "MOMENTUM",
        { signalQlooIds: ["E"] },
        ok([
          { points: [{ date: "d", rankVelocity: 2, velocityFoldChange: 1.5 }] },
        ]),
      ).stance,
    ).toBe("SUPPORTS");
    expect(
      evaluateClaim(
        "AUDIENCE_PROFILE",
        { signalQlooIds: ["E"] },
        ok([{ dimension: "age", band: "25-34", index: 0.3 }]),
      ).stance,
    ).toBe("NEUTRAL");
  });
});

describe("evidence planning (AGENT_WORKFLOW §7, §8.1)", () => {
  const [M, A, B5, B6] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const entities = new Map([
    [M, { qlooId: "M-BR", domain: "movie", kind: "entity" as const }],
    [A, { qlooId: "A-VAN", domain: "artist", kind: "entity" as const }],
    [B5, { qlooId: "B5", domain: "book", kind: "entity" as const }],
    [B6, { qlooId: "B6", domain: "book", kind: "entity" as const }],
  ]);
  const claims = [
    {
      claimId: "c1",
      hypothesisId: "h1",
      testKind: "CROSS_DOMAIN_AFFINITY" as const,
      params: {
        signalEntityIds: [M],
        targetDomain: "book" as const,
        targetEntityId: B5,
      },
      priority: 80,
      ordinal: 0,
    },
    {
      claimId: "c2",
      hypothesisId: "h1",
      testKind: "SHORTLIST_FIT" as const,
      params: {
        signalEntityIds: [A],
        optionEntityIds: [B5, B6],
        targetEntityId: B5,
      },
      priority: 80,
      ordinal: 1,
    },
    {
      claimId: "c3",
      hypothesisId: "h2",
      testKind: "CROSS_DOMAIN_AFFINITY" as const,
      params: {
        signalEntityIds: [M],
        targetDomain: "book" as const,
        targetEntityId: B6,
      },
      priority: 20,
      ordinal: 0,
    },
    {
      claimId: "c4",
      hypothesisId: "h2",
      testKind: "LOCATION_FIT" as const,
      params: { signalEntityIds: [A] },
      priority: 20,
      ordinal: 1,
    },
  ];
  const plan = (remainingQlooCalls: number) =>
    planEvidence({
      claims,
      entities,
      remainingQlooCalls,
      locationQlooId: null,
      timeWindowWeeks: 12,
      today: "2026-10-21",
    });

  it("maps claims to allowed queries, deduplicates identical queries, and marks untestable claims", () => {
    const p = plan(10);
    expect(p.queries.map((q) => [q.method, q.claimIds])).toEqual([
      ["recommend", ["c1", "c3"]],
      ["rank", ["c2"]],
    ]);
    expect(p.queries[0]!.input).toEqual({
      targetType: "book",
      signals: ["M-BR"],
      limit: 20,
    });
    expect(p.unsupported).toEqual([
      { claimId: "c4", reason: "No resolved venue locality" },
    ]);
    expect(p.resolved.get("c2")).toMatchObject({
      signalQlooIds: ["A-VAN"],
      optionQlooIds: ["B5", "B6"],
      targetQlooId: "B5",
    });
  });

  it("trims to the remaining Qloo budget by priority; trimmed claims become UNTESTED_BUDGET", () => {
    const p = plan(1);
    expect(p.queries.map((q) => q.method)).toEqual(["recommend"]);
    expect(p.untestedBudget).toEqual(["c2"]);
    expect(plan(0).untestedBudget.sort()).toEqual(["c1", "c2", "c3"]);
  });
});
