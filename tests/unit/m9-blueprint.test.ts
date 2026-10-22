import { describe, expect, it } from "vitest";
import { blueprintDraftValidator } from "../../packages/agent/src";
import {
  BlueprintContent,
  SECTION_TITLE,
  assembleBlueprint,
  blueprintMarkdown,
  citationOrder,
  deriveConstraints,
  evidenceBlocks,
  normalizeUserRevision,
  traceabilityIssues,
  traceabilityReport,
  untestedQuestions,
  type ComposeHypothesis,
} from "../../packages/core/src";

const U = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const hyp = (fixture = false): ComposeHypothesis => ({
  id: U(1),
  title: "Atlas × Gallery",
  status: "PARTIALLY_SUPPORTED",
  claims: [
    {
      id: U(10),
      ordinal: 0,
      statement: "Fans favor the gallery",
      status: "TESTED",
    },
    {
      id: U(11),
      ordinal: 1,
      statement: "Audiences share taste",
      status: "TESTED",
    },
    {
      id: U(12),
      ordinal: 2,
      statement: "Interest is rising",
      status: "UNSUPPORTED",
    },
  ],
  evidence: [
    {
      id: U(20),
      claimId: U(10),
      stance: "SUPPORTS",
      rationale:
        "SUPPORTS because the target ranked 2 of 20 (top quartile by aggregate affinity)",
      provenanceClass: fixture ? "DEVELOPMENT_FIXTURE" : "QLOO_SOURCED",
    },
    {
      id: U(21),
      claimId: U(11),
      stance: "CONTRADICTS",
      rationale: "CONTRADICTS because the target is absent from a full top 20",
      provenanceClass: fixture ? "DEVELOPMENT_FIXTURE" : "QLOO_SOURCED",
    },
  ],
  feasibilityRules: [
    {
      rule: "CAPACITY",
      effect: -0.3,
      detail: "A concert usually needs ~80+ people; the venue holds 40",
    },
    {
      rule: "LOCATION_EVIDENCE",
      effect: 0.1,
      detail: "Location evidence supports the venue's area",
    },
  ],
});

const draft = {
  title: "Atlas evenings",
  concept: "A monthly evening pairing the two worlds.",
  blocks: [
    {
      section: "programming" as const,
      text: "Open with a host introduction.",
      provenance: "MODEL_INTERPRETATION" as const,
      evidenceIds: [U(20)],
    },
    {
      section: "atmosphere" as const,
      text: "Low light and printed cards.",
      provenance: "CREATIVE_SPECULATION" as const,
      evidenceIds: [],
    },
  ],
  mitigations: [{ constraintKey: "budget", text: "Borrow equipment." }],
  openQuestions: ["Which weekday suits regulars?"],
  decisionSummary: "Composed.",
};
const brief = {
  venue: { type: "cafe", capacity: 40 },
  constraints: { budgetBand: "low", durationMinutes: 120 },
};

function compose(fixture = false) {
  const h = hyp(fixture);
  return assembleBlueprint({
    format: "event",
    draft,
    facts: evidenceBlocks([h]),
    constraints: deriveConstraints(brief, [h]),
    questions: untestedQuestions([h]),
  });
}

describe("composition: facts, interpretation, and speculation stay apart", () => {
  it("writes one cited fact per graded claim and labels synthetic evidence as fixtures", () => {
    const live = evidenceBlocks([hyp()]);
    expect(
      live.map((f) => [f.section, f.block.provenance, f.block.evidenceIds]),
    ).toEqual([
      ["audience", "APP_DERIVED", [U(20)]],
      ["risks", "APP_DERIVED", [U(21)]],
    ]);
    expect(live[0]!.block.text).toContain(
      "not a forecast of attendance or sales",
    );
    expect(
      evidenceBlocks([hyp(true)]).every(
        (f) => f.block.provenance === "DEVELOPMENT_FIXTURE",
      ),
    ).toBe(true);
    expect(untestedQuestions([hyp()])).toEqual([
      expect.stringContaining(
        "not testable with Qloo's documented capabilities",
      ),
    ]);
  });

  it("EB-A2: identifies brief, feasibility, and evidence constraints with severity", () => {
    const c = deriveConstraints(brief, [hyp()]);
    expect(c.map((x) => [x.key, x.severity, x.source])).toEqual([
      ["capacity", "info", "brief"],
      ["budget", "caution", "brief"],
      ["duration", "info", "brief"],
      ["feasibility:CAPACITY", "blocking", "feasibility"],
      [`evidence:${U(21)}`, "caution", "evidence"],
    ]);
    // Positive rules are not constraints.
    expect(c.some((x) => x.key === "feasibility:LOCATION_EVIDENCE")).toBe(
      false,
    );
    expect(
      deriveConstraints({ venue: { type: "cafe" }, constraints: {} }, []),
    ).toEqual([]);
  });

  it("assembles every section in order, attaches mitigations, and validates against the schema", () => {
    const bp = BlueprintContent.parse(compose());
    expect(bp.sections.map((s) => s.kind)).toEqual(Object.keys(SECTION_TITLE));
    expect(bp.conceptProvenance).toBe("CREATIVE_SPECULATION");
    expect(
      bp.constraintsIdentified.find((c) => c.key === "budget")!.mitigation,
    ).toBe("Borrow equipment.");
    expect(bp.openQuestions).toHaveLength(2);
    const report = traceabilityReport(bp, new Set([U(20), U(21)]));
    expect(report).toMatchObject({
      blocks: 5, // concept + 2 facts + 2 plan blocks
      evidenceBacked: 2,
      interpretation: 1,
      speculation: 2,
      citations: 4,
      unresolved: [],
    });
    expect(traceabilityIssues(bp, new Set([U(20), U(21)]))).toEqual([]);
    expect(traceabilityIssues(bp, new Set([U(20)]))).toEqual([
      `risks.0: unknown evidence ${U(21)}`,
      `constraints.4: unknown evidence ${U(21)}`,
    ]);
  });

  it("recompose replaces one section and leaves the rest untouched", () => {
    const base = compose();
    const next = assembleBlueprint({
      format: "event",
      draft: {
        ...draft,
        blocks: [
          {
            section: "promotion",
            text: "Notice boards.",
            provenance: "CREATIVE_SPECULATION",
            evidenceIds: [],
          },
        ],
      },
      facts: evidenceBlocks([hyp()]),
      constraints: [],
      questions: [],
      onlySection: "promotion",
      base,
    });
    expect(next.sections.find((s) => s.kind === "programming")).toEqual(
      base.sections.find((s) => s.kind === "programming"),
    );
    expect(
      next.sections.find((s) => s.kind === "promotion")!.blocks[0]!.text,
    ).toBe("Notice boards.");
    expect(next.constraintsIdentified).toEqual(base.constraintsIdentified);
  });
});

describe("EB-4: user revisions — the server decides provenance", () => {
  const ids = new Set([U(20), U(21)]);
  it("keeps unchanged blocks, marks edits, and demotes uncited edits to USER_PROVIDED", () => {
    const base = compose();
    const next = structuredClone(base);
    const prog = next.sections.find((s) => s.kind === "programming")!;
    prog.blocks[0] = {
      ...prog.blocks[0]!,
      text: "Open with a longer host introduction.",
    }; // kept citation
    const aud = next.sections.find((s) => s.kind === "audience")!;
    aud.blocks[0] = { ...aud.blocks[0]!, text: "Edited fact", evidenceIds: [] }; // citation removed
    next.sections
      .find((s) => s.kind === "logistics")!
      .blocks.push({
        text: "Book the back room.",
        provenance: "QLOO_SOURCED", // a client claim the server ignores
        evidenceIds: [],
      });
    next.constraintsIdentified = []; // constraints cannot be edited away
    const { content, issues, changed } = normalizeUserRevision(base, next, ids);
    expect(issues).toEqual([]);
    expect(changed).toBe(3);
    const p = content.sections.find((s) => s.kind === "programming")!
      .blocks[0]!;
    expect([p.provenance, p.edited]).toEqual(["MODEL_INTERPRETATION", true]);
    expect(
      content.sections.find((s) => s.kind === "audience")!.blocks[0]!
        .provenance,
    ).toBe("USER_PROVIDED");
    expect(
      content.sections.find((s) => s.kind === "logistics")!.blocks[0]!
        .provenance,
    ).toBe("USER_PROVIDED");
    expect(content.sections.find((s) => s.kind === "atmosphere")).toEqual(
      base.sections.find((s) => s.kind === "atmosphere"),
    );
    expect(content.constraintsIdentified).toEqual(base.constraintsIdentified);
  });

  it("rejects citations outside the experiment and reports no-op edits", () => {
    const base = compose();
    const next = structuredClone(base);
    next.sections
      .find((s) => s.kind === "measurement")!
      .blocks.push({
        text: "Cite something else",
        provenance: "USER_PROVIDED",
        evidenceIds: [U(99)],
      });
    expect(normalizeUserRevision(base, next, ids).issues).toEqual([
      `measurement.0: unknown evidence ${U(99)}`,
    ]);
    expect(
      normalizeUserRevision(base, structuredClone(base), ids).changed,
    ).toBe(0);
    const concept = normalizeUserRevision(
      base,
      { ...structuredClone(base), concept: "Mine" },
      ids,
    );
    expect(concept.content.conceptProvenance).toBe("USER_PROVIDED");
  });
});

describe("EB-A4: Markdown export fidelity", () => {
  it("contains every section, every block's provenance label, and the dated appendix", () => {
    const bp = compose(true);
    const order = citationOrder(bp);
    expect(order).toEqual([U(20), U(21)]);
    const appendix = order.map((id, i) => ({
      id,
      label: `E-${i + 1}`,
      hypothesisTitle: "Atlas × Gallery",
      claim: i ? "Audiences share taste" : "Fans favor the gallery",
      stance: i ? "CONTRADICTS" : "SUPPORTS",
      rationale: "rule | with pipe",
      evaluatorId: "X@r",
      rulesetVersion: "r",
      provenanceClass: "DEVELOPMENT_FIXTURE",
      dataOrigin: "FIXTURE",
      reused: i > 0,
      retrievedAt: "2026-10-22",
      toolInvocationId: null,
    }));
    const md = blueprintMarkdown({
      content: bp,
      appendix,
      revisionNumber: 2,
      createdAt: "2026-10-22",
      author: "USER",
      hypotheses: ["Atlas × Gallery"],
      report: traceabilityReport(bp, new Set(order)),
    });
    expect(md).toContain("Development fixtures — not real Qloo data");
    for (const title of Object.values(SECTION_TITLE))
      expect(md).toContain(`## ${title}`);
    const blocks = bp.sections.flatMap((s) => s.blocks);
    const lines = md
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes(" — _"));
    expect(lines).toHaveLength(blocks.length);
    expect(md).toContain("_FIXTURE — not Qloo data_ [E-1]");
    expect(md).toContain("_AI interpretation_ [E-1]");
    expect(md).toContain("_Creative speculation (unverified)_");
    expect(md).toContain(
      "| E-2 | Atlas × Gallery | Audiences share taste | CONTRADICTS | rule \\| with pipe |",
    );
    expect(md).toMatch(/\| FIXTURE — not Qloo data \| 2026-10-22 \|/);
    expect(md).toMatch(
      /\| FIXTURE — not Qloo data \(reused\) \| 2026-10-22 \|/,
    );
    expect(md).toContain("not attendance, sales, or commercial success");
  });
});

describe("R6 draft validator", () => {
  const validate = blueprintDraftValidator({
    evidenceIds: new Set([U(20)]),
    allowedNumbers: new Set(["40", "120"]),
    constraintKeys: new Set(["budget"]),
  });
  it("accepts grounded drafts", () => {
    expect(
      validate({ ...draft, concept: "A night for up to 40 guests." }),
    ).toEqual([]);
  });
  it("rejects invented numbers, unknown citations and keys, and outcome promises", () => {
    const codes = validate({
      ...draft,
      concept: "Expect 200 attendees; this will definitely sell out.",
      blocks: [{ ...draft.blocks[0]!, evidenceIds: [U(77)] }],
      mitigations: [{ constraintKey: "venue-size", text: "Rent more chairs." }],
    }).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "UNGROUNDED_NUMBER",
        "OUTCOME_CLAIM",
        "UNKNOWN_CITATION",
        "UNKNOWN_CONSTRAINT",
      ]),
    );
    expect(
      validate({ ...draft, concept: "Guaranteed turnout for fans." }).map(
        (i) => i.code,
      ),
    ).toEqual(["OUTCOME_CLAIM"]);
  });
});
