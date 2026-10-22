import {
  BlueprintContent,
  BlueprintDraft,
  assembleBlueprint,
  deriveConstraints,
  evidenceBlocks,
  traceabilityIssues,
  traceabilityReport,
  untestedQuestions,
  type ComposeHypothesis,
  type SectionKind,
} from "@tessaloom/core";
import {
  blueprintDraftValidator,
  combine,
  safeUseValidator,
} from "../validators";
import { effectiveBrief } from "./loop";
import { MAX_OUTPUT, base, failLlm, fatal, llmCall, truncate } from "./common";
import type { Ports, StepContext, StepResult } from "./types";

/**
 * COMPOSITION run steps (AGENT_WORKFLOW §2 R6, §5; ADR-028). The application writes the facts
 * (one block per graded claim, citing it) and the constraints; R6 adds the plan around them as
 * interpretation or speculation. Validation then checks traceability before a revision exists.
 */
function composeInputs(ctx: StepContext) {
  const bp = ctx.blueprint!;
  const chosen = ctx.hypotheses.filter((h) => bp.hypothesisIds.includes(h.id));
  const hyps: ComposeHypothesis[] = chosen.map((h) => ({
    id: h.id,
    title: h.title,
    status: h.status,
    claims: h.claims.map((c) => ({
      id: c.id,
      ordinal: c.ordinal,
      statement: c.statement,
      status: c.status,
    })),
    evidence: h.evidence.map((e) => ({
      id: e.id,
      claimId: e.claimId,
      stance: e.stance,
      rationale: e.rationale ?? null,
      provenanceClass: e.provenanceClass ?? "APP_DERIVED",
    })),
    feasibilityRules:
      (
        h.scoreBreakdown as {
          feasibility?: {
            rules: { rule: string; effect: number; detail: string }[];
          };
        } | null
      )?.feasibility?.rules ?? [],
  }));
  const brief = effectiveBrief(ctx);
  return { bp, chosen, hyps, brief };
}

/** Numbers R6 may write: those in the brief and in the evidence rules it is given. */
function numbersIn(value: unknown): Set<string> {
  const out = new Set<string>();
  for (const m of JSON.stringify(value).matchAll(/\d+(?:\.\d+)?/g))
    out.add(m[0]);
  return out;
}

export async function composeStep(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  if (!ctx.blueprint)
    return fatal("BLUEPRINT_MISSING", "The run has no blueprint to compose");
  const { bp, chosen, hyps, brief } = composeInputs(ctx);
  if (chosen.length !== bp.hypothesisIds.length)
    return fatal(
      "BLUEPRINT_HYPOTHESES_MISSING",
      "A selected hypothesis is no longer part of this experiment",
    );
  const acc = base("BLUEPRINT_DRAFTED");
  const facts = evidenceBlocks(hyps);
  const constraints = deriveConstraints(brief, hyps);
  const questions = untestedQuestions(hyps);
  const evidenceIds = new Set(
    chosen.flatMap((h) => h.evidence.map((e) => e.id)),
  );
  const only = (bp.recompose?.section as SectionKind | undefined) ?? null;
  const input = {
    brief: {
      title: brief.title,
      challenge: brief.challenge,
      venue: brief.venue,
      constraints: brief.constraints,
      goals: brief.goals,
    },
    format: bp.format,
    hypotheses: chosen.map((h) => ({
      hypothesisId: h.id,
      title: h.title,
      premise: h.premise,
      experienceSketch: h.experienceSketch,
      status: h.status,
      compositeScore: h.compositeScore,
      claims: h.claims.map((c) => {
        const e = [...h.evidence].reverse().find((x) => x.claimId === c.id);
        return {
          statement: c.statement,
          stance: c.stance,
          evidenceId: e?.id ?? null,
          rule: e?.rationale ?? null,
        };
      }),
    })),
    facts: facts.map((f) => ({ section: f.section, text: f.block.text })),
    constraints: constraints.map((c) => ({
      constraintKey: c.key,
      constraint: c.constraint,
      severity: c.severity,
    })),
    ...(only
      ? {
          onlySection: only,
          instruction: bp.recompose?.instruction ?? null,
          currentSection:
            bp.base?.sections.find((s) => s.kind === only)?.blocks ?? [],
        }
      : {}),
    ...(bp.issues.length ? { previousValidationIssues: bp.issues } : {}),
  };
  const validate = combine(
    blueprintDraftValidator({
      evidenceIds,
      allowedNumbers: numbersIn([input.brief, facts, input.hypotheses]),
      constraintKeys: new Set(constraints.map((c) => c.key ?? "")),
    }),
    safeUseValidator,
  );
  const result = await llmCall(ctx, ports, acc, {
    role: "R6",
    promptId: "r6.compose",
    label: only ? `R6 recompose ${only}` : "R6 blueprint composition",
    input,
    inputExcerpt: {
      hypotheses: chosen.length,
      facts: facts.length,
      constraints: constraints.length,
      onlySection: only,
    },
    schema: BlueprintDraft,
    maxOutputTokens: MAX_OUTPUT.R6,
    validate,
  });
  let draft = result.ok ? result.value : null;
  if (!result.ok) {
    if (result.reason !== "INVALID_OUTPUT" || !result.salvage)
      return failLlm(result, "R6 blueprint composition", acc);
    // Keep the parts that pass on their own (the same rule as hypothesis salvage).
    const s = result.salvage;
    const ok = <T>(part: Partial<BlueprintDraft>, value: T) =>
      validate({
        title: s.title,
        concept: "concept" in part ? s.concept : "Plan",
        blocks: [],
        mitigations: [],
        openQuestions: [],
        decisionSummary: s.decisionSummary,
        ...part,
      }).length === 0
        ? value
        : null;
    const blocks = s.blocks.filter((b) => ok({ blocks: [b] }, b));
    if (!blocks.length || !ok({ concept: s.concept }, true))
      return failLlm(result, "R6 blueprint composition", acc);
    draft = {
      ...s,
      blocks,
      mitigations: s.mitigations.filter((m) => ok({ mitigations: [m] }, m)),
      openQuestions: s.openQuestions.filter((q) =>
        ok({ openQuestions: [q] }, q),
      ),
    };
    acc.events.push({
      type: "VALIDATION_FAILED",
      role: "R6",
      summary: truncate(
        `Kept ${blocks.length} of ${s.blocks.length} blueprint blocks; the rest failed grounding checks`,
      ),
    });
  }
  const content = assembleBlueprint({
    format: bp.format,
    draft: draft!,
    facts,
    constraints,
    questions,
    onlySection: only,
    base: bp.base,
  });
  acc.commit.blueprint = {
    draft: content,
    draftMeta: {
      repairAttempts: bp.repairAttempts,
      issues: [],
      recompose: bp.recompose,
    },
  };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R6",
    summary: truncate(
      only
        ? `Recomposed the ${only} section`
        : `Drafted "${content.title}": ${facts.length} evidence-backed facts, ${draft!.blocks.length} planning blocks, ${constraints.length} constraints`,
    ),
  });
  return acc;
}

export function validateBlueprintStep(ctx: StepContext): StepResult {
  const bp = ctx.blueprint;
  if (!bp?.draft)
    return fatal("BLUEPRINT_DRAFT_MISSING", "No draft to validate");
  // Every evidence record of this experiment is citable; nothing else is (EB-A1).
  const evidenceIds = new Set(
    ctx.hypotheses.flatMap((h) => h.evidence.map((e) => e.id)),
  );
  const parsed = BlueprintContent.safeParse(bp.draft);
  let content = parsed.success ? parsed.data : null;
  const issues = content
    ? traceabilityIssues(content, evidenceIds)
    : ["The draft does not match the blueprint schema"];
  if (issues.length && bp.repairAttempts < 1) {
    // One repair round: back to composition with the issues (AGENT_WORKFLOW §5).
    const acc = base("BLUEPRINT_INVALID", {
      blueprintRepairAttempts: bp.repairAttempts,
    });
    acc.commit.blueprint = {
      draft: null,
      draftMeta: {
        repairAttempts: bp.repairAttempts + 1,
        issues: issues.slice(0, 20),
        recompose: bp.recompose,
      },
    };
    acc.events.push({
      type: "VALIDATION_FAILED",
      role: "R6",
      summary: truncate(
        `Traceability check failed (${issues.length} issue${issues.length === 1 ? "" : "s"}); recomposing once`,
      ),
      payload: { issues: issues.slice(0, 10) },
    });
    return acc;
  }
  if (!content)
    return fatal("BLUEPRINT_INVALID", "The blueprint could not be validated");
  let dropped = 0;
  if (issues.length) {
    // After the repair budget: drop the offending blocks rather than keep unverifiable text.
    content = {
      ...content,
      sections: content.sections.map((s) => ({
        ...s,
        blocks: s.blocks.filter((b) => {
          const bad =
            b.evidenceIds.some((id) => !evidenceIds.has(id)) ||
            (["QLOO_SOURCED", "APP_DERIVED", "DEVELOPMENT_FIXTURE"].includes(
              b.provenance,
            ) &&
              b.evidenceIds.length === 0);
          if (bad) dropped++;
          return !bad;
        }),
      })),
      constraintsIdentified: content.constraintsIdentified.map((c) => ({
        ...c,
        evidenceIds: c.evidenceIds.filter((id) => evidenceIds.has(id)),
      })),
    };
  }
  const report = traceabilityReport(content, evidenceIds);
  const acc = base("BLUEPRINT_VALID");
  acc.commit.blueprint = {
    draft: null,
    draftMeta: null,
    revision: {
      content,
      traceabilityReport: report as unknown as Record<string, unknown>,
      changeSummary: truncate(
        bp.recompose
          ? `Recomposed the ${bp.recompose.section} section${bp.recompose.instruction ? `: ${bp.recompose.instruction}` : ""}`
          : `Composed by the agent from ${bp.hypothesisIds.length} hypothes${bp.hypothesisIds.length === 1 ? "is" : "es"}${dropped ? `; ${dropped} unverifiable block${dropped === 1 ? "" : "s"} removed` : ""}`,
      ),
    },
  };
  acc.events.push({
    type: "VALIDATION_PASSED",
    role: "R6",
    summary: truncate(
      `Traceability check passed: ${report.evidenceBacked} evidence-backed, ${report.interpretation} interpretation, ${report.speculation} speculative blocks; ${report.citations} citations resolve`,
    ),
  });
  return acc;
}
