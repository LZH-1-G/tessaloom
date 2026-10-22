import { describe, expect, it } from "vitest";
import {
  assessFeasibility,
  comparisonNarrativeValidator,
  effectiveBrief,
} from "../../packages/agent/src";
import {
  ExperimentVariables,
  compareExperiments,
  enteredExited,
  metricValues,
  overlapAtK,
  planCounterfactual,
  rbo,
  renderNarrative,
  templateNarrative,
  type CfEntity,
  type CfHypothesis,
  type CompareSide,
} from "../../packages/core/src";

const U = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("WI-A3: comparison metrics match hand-computed values", () => {
  it("overlap@K is the Jaccard of the top-K sets", () => {
    expect(overlapAtK(["a", "b", "c"], ["a", "c", "d"])).toBe(0.5); // {a,c} / {a,b,c,d}
    expect(overlapAtK(["a", "b"], ["c", "d"])).toBe(0);
    expect(overlapAtK([], [])).toBe(1);
    expect(overlapAtK(["a", "b", "c"], ["c", "x", "y"], 1)).toBe(0); // top-1: {a} vs {c}
  });

  it("RBO (p = 0.9, extrapolated)", () => {
    expect(rbo(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(rbo(["a", "b"], ["c", "d"])).toBe(0);
    // A1=1, A2=1/2, A3=1: (1/9)(0.9 + 0.5·0.81 + 0.729) + 1·0.729 = 0.955
    expect(rbo(["a", "b", "c"], ["a", "c", "b"])).toBe(0.955);
    // A1=0, A2=1: (1/9)(0 + 1·0.81) + 1·0.81 = 0.9
    expect(rbo(["a", "b"], ["b", "a"])).toBe(0.9);
  });

  it("entered and exited lists", () => {
    expect(enteredExited(["a", "b", "c"], ["c", "d", "a"])).toEqual({
      entered: ["d"],
      exited: ["b"],
    });
  });

  it("per-hypothesis deltas, rank shift, stance changes and drift", () => {
    const side = (
      id: string,
      rows: [
        string,
        string,
        number,
        string | null,
        string[] | null,
        string | null,
      ][],
    ): CompareSide => ({
      experimentId: id,
      threads: [],
      hypotheses: rows.map(
        ([lineage, status, composite, stance, results, origin], i) => ({
          id: `${id}-${lineage}`,
          lineageId: lineage,
          title: `Concept ${lineage}`,
          status,
          retired: false,
          compositeScore: composite,
          supportScore: composite,
          noveltyScore: 50,
          feasibilityScore: 80,
          claims: [
            {
              id: `${id}-${lineage}-c0`,
              ordinal: 0,
              statement: "claim",
              testKind: "CROSS_DOMAIN_AFFINITY",
              status: "TESTED",
              currentStance: stance,
            },
          ],
          evidence: results
            ? [
                {
                  id: `${id}-${lineage}-e0`,
                  claimId: `${id}-${lineage}-c0`,
                  stance: stance!,
                  toolInvocationId: `${id}-inv-${i}`,
                  dataOrigin: origin,
                  resultIds: results,
                },
              ]
            : [],
        }),
      ),
    });
    const base = side("P", [
      ["L1", "PARTIALLY_SUPPORTED", 70, "NEUTRAL", ["a", "b", "c"], "FIXTURE"],
      ["L2", "SUPPORTED", 80, "SUPPORTS", ["x", "y"], "FIXTURE"],
    ]);
    const other = side("B", [
      ["L1", "SUPPORTED", 85, "SUPPORTS", ["a", "c", "d"], "FIXTURE"],
      ["L2", "SUPPORTED", 80, "SUPPORTS", ["x", "y"], "CACHE"],
    ]);
    const m = compareExperiments(base, other, {
      dirtyQueries: 1,
      reusedQueries: 1,
    });
    expect(m.header).toEqual({
      dirtyQueries: 1,
      reusedQueries: 1,
      newQlooResults: 3,
      changedStances: 1,
      changedStatuses: 1,
      driftIndex: 0.5, // one dirty query, overlap 0.5
      rescoreOnly: false,
    });
    const l1 = m.perHypothesis.find((h) => h.lineageId === "L1")!;
    expect(l1).toMatchObject({
      compositeDelta: 15,
      baseRank: 2,
      otherRank: 1,
      rankShift: 1,
      statusChanged: true,
    });
    expect(m.perQuery).toHaveLength(1); // the CACHE reuse is not a new query
    expect(m.perQuery[0]).toMatchObject({
      overlapAtK: 0.5,
      entered: ["d"],
      exited: ["b"],
    });
    expect(m.stanceDistribution).toEqual({
      base: { NEUTRAL: 1, SUPPORTS: 1 },
      other: { SUPPORTS: 2 },
    });
  });
});

describe("WI-A4: narrative numeric fidelity", () => {
  const validate = comparisonNarrativeValidator({
    metricIds: new Set(["dirtyQueries", "changedStances"]),
    evidenceIds: new Set([U(1)]),
    rescoreOnly: false,
  });
  it("accepts placeholders and known citations only", () => {
    expect(
      validate({
        text: "The branch re-ran {{metric:dirtyQueries}} queries; {{metric:changedStances}} claims changed.",
        citedEvidenceIds: [U(1)],
      }),
    ).toEqual([]);
    const issues = validate({
      text: "The branch re-ran 7 queries and {{metric:invented}} more.",
      citedEvidenceIds: [U(2)],
    }).map((i) => i.code);
    expect(issues).toEqual([
      "UNGROUNDED_NUMBER",
      "UNKNOWN_METRIC",
      "UNKNOWN_EVIDENCE",
    ]);
  });

  it("forbids implying new data after a rescore-only branch", () => {
    const rescore = comparisonNarrativeValidator({
      metricIds: new Set(),
      evidenceIds: new Set(),
      rescoreOnly: true,
    });
    expect(
      rescore({
        text: "Rescored with existing evidence, so no new Qloo data was retrieved.",
        citedEvidenceIds: [],
      }),
    ).toEqual([]);
    expect(
      rescore({
        text: "Fresh Qloo results moved the ranking.",
        citedEvidenceIds: [],
      }).map((i) => i.code),
    ).toEqual(["IMPLIES_NEW_DATA"]);
  });

  it("the deterministic template renders only metric values", () => {
    const m = compareExperiments(
      { experimentId: "a", hypotheses: [], threads: [] },
      { experimentId: "b", hypotheses: [], threads: [] },
      { dirtyQueries: 0, reusedQueries: 4 },
    );
    const text = templateNarrative(m);
    expect(text).toMatch(/no new Qloo data/);
    expect(text.replace(/\{\{metric:[^}]+\}\}/g, "")).not.toMatch(/\d/);
    expect(renderNarrative(text, metricValues(m))).toContain("0 of 0 claims");
  });
});

// ---------------------------------------------------------------------------

const ent = (
  n: number,
  domain: string,
  kind: CfEntity["kind"] = "entity",
): CfEntity => ({
  id: U(n),
  qlooId: `Q${n}`,
  domain,
  kind,
  name: `E${n}`,
});
const entities = new Map(
  [
    ent(1, "book"),
    ent(2, "movie"),
    ent(3, "place"),
    ent(4, "artist"),
    ent(5, "book"),
    ent(9, "locality", "locality"),
    ent(10, "locality", "locality"),
  ].map((e) => [e.id, e]),
);
const claim = (
  id: number,
  testKind: CfHypothesis["claims"][number]["testKind"],
  params: Record<string, unknown>,
  status = "TESTED",
) => ({
  id: U(id),
  ordinal: id % 10,
  statement: `claim ${id}`,
  testKind,
  params: params as never,
  status,
  stance: status === "TESTED" ? "SUPPORTS" : null,
  evidenceId: status === "TESTED" ? U(id + 500) : null,
});
const HYPS: CfHypothesis[] = [
  {
    id: U(100),
    title: "H",
    compositeScore: 70,
    claims: [
      claim(101, "CROSS_DOMAIN_AFFINITY", {
        signalEntityIds: [U(1)],
        targetDomain: "place",
        targetEntityId: U(3),
      }),
      claim(102, "AUDIENCE_BRIDGE", {
        signalEntityIds: [U(2)],
        compareEntityIds: [U(4)],
      }),
      claim(103, "LOCATION_FIT", { signalEntityIds: [U(2)] }),
    ],
  },
  {
    id: U(200),
    title: "G",
    compositeScore: 60,
    claims: [
      claim(201, "MOMENTUM", { signalEntityIds: [U(2)] }),
      claim(
        202,
        "CROSS_DOMAIN_AFFINITY",
        {
          signalEntityIds: [U(2)],
          targetDomain: "artist",
        },
        "UNTESTED_BUDGET",
      ),
    ],
  },
];
const variables = ExperimentVariables.parse({
  targetDomains: ["artist", "book", "movie", "place"],
});
const plan = (delta: Record<string, unknown>) =>
  planCounterfactual({
    hypotheses: HYPS,
    entities,
    seeds: [
      { entityId: U(1), role: "seed" },
      { entityId: U(2), role: "seed" },
      { entityId: U(9), role: "location" },
    ],
    variables,
    delta: delta as never,
    today: "2026-10-21",
  });
const decisions = (p: ReturnType<typeof plan>) =>
  Object.fromEntries(p.claims.map((c) => [c.parentClaimId, c.decision]));

describe("§7.2 dirty-set correctness for each delta type", () => {
  it("seed swap dirties exactly the queries that use the seed", () => {
    const p = plan({ seeds: { swap: [{ from: U(1), to: U(5) }] } });
    expect(decisions(p)).toEqual({
      [U(101)]: "DIRTY",
      [U(102)]: "REUSE",
      [U(103)]: "REUSE",
      [U(201)]: "REUSE",
      [U(202)]: "INHERIT",
    });
    expect(p.dirtyQueries).toBe(1);
    // compareAudiences, wherePopular and trends; the untested claim was never executed.
    expect(p.reusedQueries).toBe(3);
    expect(
      p.claims.find((c) => c.parentClaimId === U(101))!.params.signalEntityIds,
    ).toEqual([U(5)]);
  });

  it("domain add adds discovery threads only; domain remove excludes its claims", () => {
    const add = plan({ targetDomains: { add: ["tv_show"] } });
    expect(Object.values(decisions(add)).filter((d) => d === "DIRTY")).toEqual(
      [],
    );
    expect(add.discovery.map((d) => [d.seedEntityId, d.domain])).toEqual([
      [U(1), "tv_show"],
      [U(2), "tv_show"],
    ]);
    expect(add.dirtyQueries).toBe(2);
    const remove = plan({ targetDomains: { remove: ["place"] } });
    expect(decisions(remove)[U(101)]).toBe("UNSUPPORTED");
    expect(remove.dirtyQueries).toBe(0);
  });

  it("weights-only and constraint-only deltas are rescore-only", () => {
    for (const delta of [
      { scoringWeights: { support: 0.5, novelty: 0.25, feasibility: 0.25 } },
      { constraints: { capacity: 120 } },
      { collisionTension: 0.8 },
    ]) {
      const p = plan(delta);
      expect(p.dirtyQueries).toBe(0);
      expect(p.rescoreOnly).toBe(true);
      expect(p.needsConfirmation).toBe(false);
    }
  });

  it("location and time window dirty only their own test kinds", () => {
    const loc = plan({ location: { localityEntityId: U(10) } });
    expect(decisions(loc)).toMatchObject({
      [U(103)]: "DIRTY",
      [U(201)]: "REUSE",
      [U(101)]: "REUSE",
    });
    expect(loc.dirtyQueries).toBe(1);
    const time = plan({ timeWindow: { weeks: 26 } });
    expect(decisions(time)).toMatchObject({
      [U(201)]: "DIRTY",
      [U(103)]: "REUSE",
    });
    expect(time.dirtyQueries).toBe(1);
    const noLoc = plan({ location: null });
    expect(decisions(noLoc)[U(103)]).toBe("UNSUPPORTED");
  });

  it("rejects what the harness cannot apply and invalid swaps", () => {
    expect(
      plan({ audienceBand: { ageBand: "25-34" } }).unsupported,
    ).toHaveLength(1);
    expect(plan({ seeds: { add: [U(5)] } }).unsupported).toHaveLength(1);
    expect(
      plan({ seeds: { swap: [{ from: U(1), to: U(2) }] } }).unsupported[0],
    ).toMatch(/already a seed/);
    expect(
      plan({ seeds: { swap: [{ from: U(3), to: U(5) }] } }).unsupported[0],
    ).toMatch(/not a seed/);
  });

  it("is deterministic and asks for confirmation above the auto-approve threshold", () => {
    expect(plan({ timeWindow: { weeks: 52 } })).toEqual(
      plan({ timeWindow: { weeks: 52 } }),
    );
    const big = plan({
      seeds: {
        swap: [
          { from: U(1), to: U(5) },
          { from: U(2), to: U(4) },
        ],
      },
      targetDomains: { add: ["tv_show", "podcast", "videogame"] },
    });
    expect(big.dirtyQueries).toBeGreaterThan(6);
    expect(big.needsConfirmation).toBe(true);
  });
});

describe("branch constraints feed feasibility", () => {
  it("a smaller capacity in the branch triggers the capacity rule", () => {
    const ctx = {
      brief: {
        content: {
          title: "t",
          challenge: "c",
          interests: [],
          venue: { type: "bar", capacity: 300 },
          constraints: { budgetBand: "high" },
          goals: [],
        },
      },
      experiment: { variables: { constraints: { capacity: 40 } } },
    } as never;
    const brief = effectiveBrief(ctx);
    expect(brief.venue.capacity).toBe(40);
    const f = assessFeasibility({
      text: "A late-night concert",
      brief,
      locationStances: [],
    });
    expect(f.rules.map((r) => r.rule)).toEqual(["CAPACITY"]);
  });
});
