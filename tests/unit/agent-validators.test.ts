import { describe, expect, it } from "vitest";
import {
  blueprintProvenanceValidator,
  combine,
  critiqueValidator,
  hypothesisBatchValidator,
  hypothesisRevisionValidator,
  numericFidelityIssues,
  safeUseValidator,
} from "../../packages/agent/src";
import {
  HypothesisBatch,
  uuidv7,
  type HypothesisDraft,
} from "../../packages/core/src";

const [A, B, C, T, OUT] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
const ctx = {
  entityIds: new Set([A, B, C, T]),
  tagIds: new Set([T]),
  domainOf: new Map([
    [A, "movie"],
    [B, "artist"],
    [C, "book"],
  ]),
  maxClaimsPerHypothesis: 3,
};

function draft(overrides: Partial<HypothesisDraft> = {}): HypothesisDraft {
  return {
    tempId: "h1",
    title: "Noir listening night",
    premise: "Film noir fans and jazz fans may share an audience.",
    elementRefs: [
      { entityId: A, role: "anchor" },
      { entityId: B, role: "accent" },
    ],
    claims: [
      {
        tempId: "c1",
        statement: "Audiences of A show affinity for artists",
        testKind: "CROSS_DOMAIN_AFFINITY",
        params: {
          signalEntityIds: [A],
          targetDomain: "artist",
          targetEntityId: B,
        },
      },
    ],
    creativeElements: [],
    experienceSketch: "A screening followed by a live set.",
    ...overrides,
  };
}

describe("entity grounding and claim params", () => {
  const validate = hypothesisBatchValidator(ctx);

  it("accepts a grounded batch", () => {
    const batch = HypothesisBatch.parse({
      hypotheses: [draft()],
      decisionSummary: "One.",
    });
    expect(validate(batch)).toEqual([]);
  });

  it("rejects ungrounded elements and params", () => {
    const issues = validate({
      hypotheses: [
        draft({
          elementRefs: [
            { entityId: A, role: "anchor" },
            { entityId: OUT, role: "accent" },
          ],
          claims: [
            {
              tempId: "c1",
              statement: "x",
              testKind: "CROSS_DOMAIN_AFFINITY",
              params: { signalEntityIds: [OUT], targetDomain: "artist" },
            },
          ],
        }),
      ],
      decisionSummary: "x",
    });
    expect(issues.map((i) => i.code).sort()).toEqual([
      "UNGROUNDED_ENTITY",
      "UNGROUNDED_PARAM",
    ]);
  });

  it("checks per-test-kind params, tag kinds, momentum domains, and duplicates", () => {
    const claims: HypothesisDraft["claims"] = [
      {
        tempId: "c1",
        statement: "x",
        testKind: "CROSS_DOMAIN_AFFINITY",
        params: { signalEntityIds: [A] },
      },
      {
        tempId: "c2",
        statement: "x",
        testKind: "SHORTLIST_FIT",
        params: {
          signalEntityIds: [A],
          optionEntityIds: [B, C],
          targetEntityId: A,
        },
      },
      {
        tempId: "c2",
        statement: "x",
        testKind: "TAG_RESONANCE",
        params: { signalEntityIds: [A], tagEntityIds: [B] },
      },
    ];
    const issues = validate({
      hypotheses: [
        draft({ claims }),
        draft({
          claims: [
            {
              ...claims[0]!,
              testKind: "MOMENTUM",
              params: { signalEntityIds: [A, B] },
            },
          ],
        }),
      ],
      decisionSummary: "x",
    });
    const codes = issues.map((i) => i.code);
    expect(codes.filter((c) => c === "CLAIM_PARAMS")).toHaveLength(3); // missing targetDomain, target not an option, mixed momentum
    expect(codes).toContain("NOT_A_TAG");
    expect(codes).toContain("DUPLICATE_CLAIM_ID");
    expect(codes).toContain("DUPLICATE_HYPOTHESIS_ID");
  });

  it("validates revisions against known hypotheses", () => {
    const H1 = uuidv7();
    const validateRev = hypothesisRevisionValidator({
      ...ctx,
      hypothesisIds: new Set([H1]),
    });
    expect(
      validateRev({
        refined: [{ ...draft(), revisionOfId: H1 }],
        retiredIds: [],
        spawned: [],
        decisionSummary: "x",
      }),
    ).toEqual([]);
    const codes = validateRev({
      refined: [{ ...draft(), revisionOfId: H1 }],
      retiredIds: [H1, OUT],
      spawned: [],
      decisionSummary: "x",
    }).map((i) => i.code);
    expect(codes).toEqual(["UNKNOWN_HYPOTHESIS", "CONFLICTING_REVISION"]);
  });
});

describe("citation and stance integrity", () => {
  const H1 = uuidv7();
  const E1 = uuidv7();
  const E2 = uuidv7();
  const validate = critiqueValidator({
    hypothesisIds: new Set([H1]),
    evidenceByHypothesis: new Map([[H1, new Set([E1])]]),
  });

  it("accepts cited notes and rejects unknown or missing citations", () => {
    const ok = validate({
      perHypothesis: [
        {
          hypothesisId: H1,
          confidenceNote: "Two checks agree.",
          citedEvidenceIds: [E1],
          recommendation: "keep",
        },
      ],
      continueLoop: false,
      decisionSummary: "x",
    });
    expect(ok).toEqual([]);
    const bad = validate({
      perHypothesis: [
        {
          hypothesisId: H1,
          confidenceNote: "Note",
          citedEvidenceIds: [E2],
          recommendation: "keep",
        },
        {
          hypothesisId: H1,
          downgrade: { reason: "thin" },
          citedEvidenceIds: [],
          recommendation: "refine",
        },
        { hypothesisId: OUT, citedEvidenceIds: [], recommendation: "retire" },
      ],
      continueLoop: true,
      decisionSummary: "x",
    });
    expect(bad.map((i) => i.code)).toEqual([
      "UNKNOWN_CITATION",
      "DUPLICATE_HYPOTHESIS",
      "MISSING_CITATION",
      "UNKNOWN_HYPOTHESIS",
    ]);
  });
});

describe("numeric fidelity and provenance", () => {
  it("allows provided values and metric placeholders only", () => {
    const allowed = new Set(["0.89", "12"]);
    expect(
      numericFidelityIssues(
        "Affinity {{metric:aff_1}} rose; 12 results; 0.89 top.",
        allowed,
        "p",
      ),
    ).toEqual([]);
    expect(
      numericFidelityIssues("Attendance will rise 40%.", allowed, "p").map(
        (i) => i.code,
      ),
    ).toEqual(["UNGROUNDED_NUMBER"]);
    expect(numericFidelityIssues("Room R2D2 is fine", allowed, "p")).toEqual(
      [],
    );
  });

  it("requires citations on sourced blocks and forbids model-made fixture labels", () => {
    const E1 = uuidv7();
    const validate = blueprintProvenanceValidator(new Set([E1]));
    const issues = validate({
      title: "t",
      format: "event",
      concept: "c",
      sections: [
        {
          kind: "audience",
          blocks: [
            { text: "a", provenance: "QLOO_SOURCED", evidenceIds: [E1] },
            { text: "b", provenance: "QLOO_SOURCED", evidenceIds: [] },
            { text: "c", provenance: "DEVELOPMENT_FIXTURE", evidenceIds: [] },
            {
              text: "d",
              provenance: "CREATIVE_SPECULATION",
              evidenceIds: [OUT],
            },
          ],
        },
      ],
      constraintsIdentified: [],
      openQuestions: [],
    });
    expect(issues.map((i) => i.code)).toEqual([
      "MISSING_CITATION",
      "PROVENANCE_LABEL",
      "UNKNOWN_CITATION",
    ]);
  });
});

describe("safe use", () => {
  it("flags sensitive-trait inference, eligibility, individual probability, and causation", () => {
    const cases = [
      "The audience is likely mostly Muslim, so plan accordingly.",
      "Target conservative customers only.",
      "Use this to decide who is eligible for a loan.",
      "Each customer will likely attend the screening.",
      "This affinity proves the concept will work.",
    ];
    for (const text of cases)
      expect(safeUseValidator({ premise: text }).length, text).toBeGreaterThan(
        0,
      );
  });

  it("allows user-chosen themes and aggregate phrasing", () => {
    const fine = [
      "A queer cinema night pairing New Queer Cinema with a zine library.",
      "Audiences with affinity for film noir also show affinity for cool jazz.",
      "A health-food pop-up inspired by the novel.",
    ];
    for (const text of fine)
      expect(safeUseValidator({ premise: text }), text).toEqual([]);
  });

  it("combines validators", () => {
    const v = combine<{ premise: string }>(safeUseValidator, () => [
      { code: "X", message: "x" },
    ]);
    expect(
      v({ premise: "Each visitor will love it" }).map((i) => i.code),
    ).toEqual(["SAFE_USE_INDIVIDUAL_INFERENCE", "X"]);
  });
});
