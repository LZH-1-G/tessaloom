import type { BlueprintContent, BlueprintDraft } from "./schemas/domain";

/**
 * Experience Blueprint logic (PRD §6.6, AGENT_WORKFLOW §2 R6, ADR-028). Pure: the worker
 * assembles blueprints with it, the web validates user revisions and exports with it.
 *
 * Separation of knowledge kinds:
 *  - facts — blocks the application writes from stored evidence (APP_DERIVED, or
 *    DEVELOPMENT_FIXTURE for synthetic evidence); every one cites its evidence records;
 *  - AI interpretation / unverified assumptions — R6 blocks (MODEL_INTERPRETATION /
 *    CREATIVE_SPECULATION), which may cite evidence but never state new facts;
 *  - user edits — USER_PROVIDED, or the original provenance marked "edited by you" when the
 *    person kept the block's citations.
 */
export const BLUEPRINT_VERSION = "blueprint-1.0.0";

export type SectionKind = BlueprintContent["sections"][number]["kind"];
export type Block = BlueprintContent["sections"][number]["blocks"][number];
export type Constraint = BlueprintContent["constraintsIdentified"][number];

export const SECTION_ORDER: SectionKind[] = [
  "audience",
  "programming",
  "atmosphere",
  "partners",
  "promotion",
  "logistics",
  "risks",
  "measurement",
];
export const SECTION_TITLE: Record<SectionKind, string> = {
  audience: "Audience",
  programming: "Programming",
  atmosphere: "Atmosphere",
  partners: "Partners",
  promotion: "Promotion",
  logistics: "Logistics",
  risks: "Constraints & risks",
  measurement: "Measurement",
};
export const PROVENANCE_TEXT: Record<string, string> = {
  QLOO_SOURCED: "Qloo data",
  APP_DERIVED: "Computed from Qloo data",
  MODEL_INTERPRETATION: "AI interpretation",
  CREATIVE_SPECULATION: "Creative speculation (unverified)",
  USER_PROVIDED: "You",
  DEVELOPMENT_FIXTURE: "FIXTURE — not Qloo data",
};

// ---------------------------------------------------------------------------
// Inputs the application controls

export interface ComposeEvidence {
  id: string;
  claimId: string;
  stance: string;
  rationale: string | null;
  provenanceClass: string;
}

export interface ComposeHypothesis {
  id: string;
  title: string;
  status: string;
  claims: { id: string; ordinal: number; statement: string; status: string }[];
  evidence: ComposeEvidence[];
  feasibilityRules: { rule: string; effect: number; detail: string }[];
}

export interface ComposeBrief {
  venue: { type: string; capacity?: number; localityText?: string };
  constraints: { budgetBand?: string; durationMinutes?: number };
}

const latest = (h: ComposeHypothesis, claimId: string) =>
  [...h.evidence].reverse().find((e) => e.claimId === claimId) ?? null;

/** Evidence-derived blocks (facts): one per graded claim, written by the application. */
export function evidenceBlocks(hyps: ComposeHypothesis[]): {
  section: SectionKind;
  block: Block;
}[] {
  const out: { section: SectionKind; block: Block }[] = [];
  for (const h of hyps)
    for (const c of [...h.claims].sort((a, b) => a.ordinal - b.ordinal)) {
      const e = latest(h, c.id);
      if (!e) continue;
      const provenance =
        e.provenanceClass === "DEVELOPMENT_FIXTURE"
          ? "DEVELOPMENT_FIXTURE"
          : "APP_DERIVED";
      // The stance is already in the lead, so drop the rationale's "SUPPORTS because" prefix.
      const reason = e.rationale?.replace(/^[A-Z_]+ because /, "");
      const rule = reason ? `: ${reason}` : "";
      const lead =
        e.stance === "SUPPORTS"
          ? "Evidence supports"
          : e.stance === "CONTRADICTS"
            ? "Evidence contradicts"
            : e.stance === "NEUTRAL"
              ? "Evidence is neutral on"
              : "Evidence is insufficient for";
      out.push({
        section:
          e.stance === "SUPPORTS"
            ? "audience"
            : e.stance === "CONTRADICTS"
              ? "risks"
              : "measurement",
        block: {
          text: `${lead} “${c.statement}” (${h.title})${rule}. Aggregate audience signal, not a forecast of attendance or sales.`,
          provenance,
          evidenceIds: [e.id],
        },
      });
    }
  return out;
}

/** Practical constraints from the brief, feasibility rules, and contradicting evidence (EB-A2). */
export function deriveConstraints(
  brief: ComposeBrief,
  hyps: ComposeHypothesis[],
): Constraint[] {
  const out: Constraint[] = [];
  if (brief.venue.capacity)
    out.push({
      key: "capacity",
      constraint: `The venue holds up to ${brief.venue.capacity} guests; programming, seating, and promotion must fit that room.`,
      severity: "info",
      evidenceIds: [],
      source: "brief",
    });
  if (brief.constraints.budgetBand)
    out.push({
      key: "budget",
      constraint: `Budget band: ${brief.constraints.budgetBand}. ${brief.constraints.budgetBand === "low" ? "Favor existing equipment, volunteer or community partners, and free promotion channels." : "Costs still need a line-by-line estimate."}`,
      severity: brief.constraints.budgetBand === "low" ? "caution" : "info",
      evidenceIds: [],
      source: "brief",
    });
  if (brief.constraints.durationMinutes)
    out.push({
      key: "duration",
      constraint: `The slot is ${brief.constraints.durationMinutes} minutes, including arrival and changeover.`,
      severity: "info",
      evidenceIds: [],
      source: "brief",
    });
  if (brief.venue.type === "online")
    out.push({
      key: "venue",
      constraint:
        "The venue is online: physical elements need a remote format.",
      severity: "caution",
      evidenceIds: [],
      source: "brief",
    });
  const seen = new Set<string>();
  for (const h of hyps)
    for (const r of h.feasibilityRules) {
      if (r.effect >= 0 || seen.has(`${r.rule}:${r.detail}`)) continue;
      seen.add(`${r.rule}:${r.detail}`);
      out.push({
        key: `feasibility:${r.rule}`,
        constraint: `${r.detail} (${h.title}).`,
        severity:
          r.rule === "VENUE" || r.effect <= -0.3 ? "blocking" : "caution",
        evidenceIds: [],
        source: "feasibility",
      });
    }
  for (const h of hyps)
    for (const c of h.claims) {
      const e = latest(h, c.id);
      if (e?.stance !== "CONTRADICTS") continue;
      out.push({
        key: `evidence:${e.id}`,
        constraint: `An evidence check contradicts “${c.statement}” (${h.title}); do not rely on that assumption.`,
        severity: "caution",
        evidenceIds: [e.id],
        source: "evidence",
      });
    }
  return out;
}

/** Claims nobody could test become open questions (honest gaps, not facts). */
export function untestedQuestions(hyps: ComposeHypothesis[]): string[] {
  return hyps.flatMap((h) =>
    h.claims
      .filter((c) => !latest(h, c.id))
      .map(
        (c) =>
          `Untested: “${c.statement}” (${h.title}) — ${c.status === "UNSUPPORTED" ? "not testable with Qloo's documented capabilities" : "no evidence was collected"}.`,
      ),
  );
}

/** Merge application facts and the R6 draft into a blueprint (sections in a fixed order). */
export function assembleBlueprint(input: {
  format: BlueprintContent["format"];
  draft: BlueprintDraft;
  facts: { section: SectionKind; block: Block }[];
  constraints: Constraint[];
  questions: string[];
  /** Restrict to one section (recompose); others come from `base`. */
  onlySection?: SectionKind | null;
  base?: BlueprintContent | null;
}): BlueprintContent {
  const { draft } = input;
  const mitigation = new Map(
    draft.mitigations.map((m) => [m.constraintKey, m.text]),
  );
  const sectionBlocks = (kind: SectionKind): Block[] => [
    ...input.facts.filter((f) => f.section === kind).map((f) => f.block),
    ...draft.blocks
      .filter((b) => b.section === kind)
      .map((b) => ({
        text: b.text,
        provenance: b.provenance,
        evidenceIds: [...new Set(b.evidenceIds)],
      })),
  ];
  if (input.onlySection && input.base)
    return {
      ...input.base,
      sections: SECTION_ORDER.map((kind) =>
        kind === input.onlySection
          ? { kind, blocks: sectionBlocks(kind) }
          : (input.base!.sections.find((s) => s.kind === kind) ?? {
              kind,
              blocks: [],
            }),
      ),
    };
  return {
    title: draft.title,
    format: input.format,
    concept: draft.concept,
    conceptProvenance: "CREATIVE_SPECULATION",
    sections: SECTION_ORDER.map((kind) => ({
      kind,
      blocks: sectionBlocks(kind),
    })),
    constraintsIdentified: input.constraints.map((c) => {
      const m = c.key ? mitigation.get(c.key) : undefined;
      return m ? { ...c, mitigation: m } : c;
    }),
    openQuestions: [...input.questions, ...draft.openQuestions],
  };
}

// ---------------------------------------------------------------------------
// Traceability (EB-A1, PRD EB-3)

export interface TraceabilityReport {
  version: string;
  blocks: number;
  byProvenance: Record<string, number>;
  /** Facts computed from Qloo (or fixture) evidence. */
  evidenceBacked: number;
  interpretation: number;
  speculation: number;
  user: number;
  citedBlocks: number;
  citations: number;
  unresolved: string[];
  edited: number;
}

export function traceabilityReport(
  content: BlueprintContent,
  evidenceIds: ReadonlySet<string>,
): TraceabilityReport {
  const blocks = content.sections.flatMap((s) => s.blocks);
  const byProvenance: Record<string, number> = {};
  const add = (p: string) => (byProvenance[p] = (byProvenance[p] ?? 0) + 1);
  add(content.conceptProvenance ?? "CREATIVE_SPECULATION");
  for (const b of blocks) add(b.provenance);
  const cited = [
    ...blocks.flatMap((b) => b.evidenceIds),
    ...content.constraintsIdentified.flatMap((c) => c.evidenceIds),
  ];
  const n = (k: string) => byProvenance[k] ?? 0;
  return {
    version: BLUEPRINT_VERSION,
    blocks: blocks.length + 1,
    byProvenance,
    evidenceBacked:
      n("APP_DERIVED") + n("QLOO_SOURCED") + n("DEVELOPMENT_FIXTURE"),
    interpretation: n("MODEL_INTERPRETATION"),
    speculation: n("CREATIVE_SPECULATION"),
    user: n("USER_PROVIDED"),
    citedBlocks: blocks.filter((b) => b.evidenceIds.length > 0).length,
    citations: cited.length,
    unresolved: [...new Set(cited.filter((id) => !evidenceIds.has(id)))],
    edited: blocks.filter((b) => b.edited).length,
  };
}

/** Blocks claiming to be facts must cite; every citation must resolve (EB-A1). */
export function traceabilityIssues(
  content: BlueprintContent,
  evidenceIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  content.sections.forEach((s) =>
    s.blocks.forEach((b, i) => {
      if (
        ["QLOO_SOURCED", "APP_DERIVED", "DEVELOPMENT_FIXTURE"].includes(
          b.provenance,
        ) &&
        b.evidenceIds.length === 0
      )
        issues.push(`${s.kind}.${i}: an evidence-backed block cites nothing`);
      for (const id of b.evidenceIds)
        if (!evidenceIds.has(id))
          issues.push(`${s.kind}.${i}: unknown evidence ${id}`);
    }),
  );
  content.constraintsIdentified.forEach((c, i) => {
    for (const id of c.evidenceIds)
      if (!evidenceIds.has(id))
        issues.push(`constraints.${i}: unknown evidence ${id}`);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// User revisions (EB-4): the server decides provenance, never the client.

export function normalizeUserRevision(
  base: BlueprintContent,
  next: BlueprintContent,
  evidenceIds: ReadonlySet<string>,
): { content: BlueprintContent; issues: string[]; changed: number } {
  const issues: string[] = [];
  let changed = 0;
  const sections = SECTION_ORDER.map((kind) => {
    const before = base.sections.find((s) => s.kind === kind)?.blocks ?? [];
    const after = next.sections.find((s) => s.kind === kind)?.blocks ?? [];
    const blocks = after.map((b, i): Block => {
      const prior = before[i];
      const ids = [...new Set(b.evidenceIds)];
      for (const id of ids)
        if (!evidenceIds.has(id))
          issues.push(`${kind}.${i}: unknown evidence ${id}`);
      if (
        prior &&
        prior.text === b.text &&
        prior.evidenceIds.join() === ids.join()
      )
        return prior; // unchanged: provenance stays exactly as the agent wrote it
      changed++;
      const keptCitations =
        !!prior &&
        ids.length > 0 &&
        ids.every((id) => prior.evidenceIds.includes(id));
      return keptCitations
        ? {
            text: b.text,
            provenance: prior!.provenance,
            evidenceIds: ids,
            edited: true,
          }
        : {
            text: b.text,
            provenance: "USER_PROVIDED",
            evidenceIds: ids,
            edited: true,
          };
    });
    if (after.length < before.length) changed += before.length - after.length;
    return { kind, blocks };
  });
  const conceptChanged = next.concept !== base.concept;
  if (conceptChanged) changed++;
  if (next.title !== base.title) changed++;
  if (next.openQuestions.join("\n") !== base.openQuestions.join("\n"))
    changed++;
  return {
    content: {
      title: next.title,
      format: base.format,
      concept: next.concept,
      conceptProvenance: conceptChanged
        ? "USER_PROVIDED"
        : (base.conceptProvenance ?? "CREATIVE_SPECULATION"),
      sections,
      // Constraints are derived by the application; edits never change them.
      constraintsIdentified: base.constraintsIdentified,
      openQuestions: next.openQuestions.map((q) => q.trim()).filter(Boolean),
    },
    issues,
    changed,
  };
}

// ---------------------------------------------------------------------------
// Export (EB-5, EB-A4)

export interface AppendixEntry {
  id: string;
  label: string; // E-1, E-2, … in order of first citation
  hypothesisTitle: string;
  claim: string;
  stance: string;
  rationale: string | null;
  evaluatorId: string;
  rulesetVersion: string;
  provenanceClass: string;
  /** Origin of the data itself: a CACHE copy reports the call it was copied from. */
  dataOrigin: string | null;
  /** True when the evidence reuses an earlier call (e.g. a What-if branch). */
  reused: boolean;
  /** When the underlying data was retrieved (the original call for reused evidence). */
  retrievedAt: string | null;
  toolInvocationId: string | null;
}

/** "FIXTURE — not Qloo data", "LIVE", … with "(reused)" for cache copies. */
export function originLabel(a: Pick<AppendixEntry, "dataOrigin" | "reused">) {
  const base =
    a.dataOrigin === "FIXTURE"
      ? "FIXTURE — not Qloo data"
      : a.dataOrigin === "LIVE"
        ? "Qloo (live)"
        : (a.dataOrigin ?? "—");
  return a.reused ? `${base} (reused)` : base;
}

/** E-n labels in order of first citation (concept → sections → constraints). */
export function citationOrder(content: BlueprintContent): string[] {
  const ids: string[] = [];
  const push = (list: string[]) => {
    for (const id of list) if (!ids.includes(id)) ids.push(id);
  };
  for (const kind of SECTION_ORDER)
    for (const b of content.sections.find((s) => s.kind === kind)?.blocks ?? [])
      push(b.evidenceIds);
  for (const c of content.constraintsIdentified) push(c.evidenceIds);
  return ids;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function blueprintMarkdown(input: {
  content: BlueprintContent;
  appendix: AppendixEntry[];
  revisionNumber: number;
  createdAt: string;
  author: string;
  hypotheses: string[];
  report: TraceabilityReport;
}): string {
  const { content, appendix, report } = input;
  const label = new Map(appendix.map((a) => [a.id, a.label]));
  const cite = (ids: string[]) =>
    ids.length
      ? ` ${ids.map((id) => `[${label.get(id) ?? "?"}]`).join("")}`
      : "";
  const fixture =
    report.byProvenance.DEVELOPMENT_FIXTURE ||
    appendix.some((a) => a.provenanceClass === "DEVELOPMENT_FIXTURE");
  const lines: string[] = [`# ${content.title}`, ""];
  if (fixture)
    lines.push(
      "> **Development fixtures — not real Qloo data.** This blueprint was composed from synthetic test data.",
      "",
    );
  lines.push(
    `Format: ${content.format} · Revision ${input.revisionNumber} (${input.author.toLowerCase()}, ${input.createdAt}) · From: ${input.hypotheses.join("; ")}`,
    "",
    `Traceability: ${report.evidenceBacked} evidence-backed · ${report.interpretation} AI interpretation · ${report.speculation} speculative · ${report.user} by you (of ${report.blocks} blocks; ${report.citations} citations, ${report.unresolved.length} unresolved).`,
    "",
    "Qloo values are aggregate audience-affinity signals. They describe shared tastes, not attendance, sales, or commercial success.",
    "",
    "## Provenance legend",
    "",
    ...Object.entries(PROVENANCE_TEXT).map(([k, v]) => `- **${v}** (${k})`),
    "",
    `## Concept _(${PROVENANCE_TEXT[content.conceptProvenance ?? "CREATIVE_SPECULATION"]})_`,
    "",
    content.concept,
    "",
  );
  for (const kind of SECTION_ORDER) {
    const blocks = content.sections.find((s) => s.kind === kind)?.blocks ?? [];
    lines.push(`## ${SECTION_TITLE[kind]}`, "");
    if (
      !blocks.length &&
      !(kind === "risks" && content.constraintsIdentified.length)
    )
      lines.push("_No blocks._", "");
    for (const b of blocks)
      lines.push(
        `- ${b.text.replace(/\r?\n/g, " ")} — _${PROVENANCE_TEXT[b.provenance] ?? b.provenance}${b.edited ? ", edited by you" : ""}_${cite(b.evidenceIds)}`,
      );
    if (blocks.length) lines.push("");
    if (kind === "risks" && content.constraintsIdentified.length) {
      lines.push(
        "| Constraint | Severity | Source | Evidence | Suggested mitigation (AI interpretation) |",
        "|---|---|---|---|---|",
        ...content.constraintsIdentified.map(
          (c) =>
            `| ${esc(c.constraint)} | ${c.severity} | ${c.source ?? "—"} | ${cite(c.evidenceIds).trim() || "—"} | ${esc(c.mitigation ?? "—")} |`,
        ),
        "",
      );
    }
  }
  lines.push("## Open questions", "");
  if (!content.openQuestions.length) lines.push("_None._");
  for (const q of content.openQuestions) lines.push(`- ${q}`);
  lines.push(
    "",
    "## Evidence appendix",
    "",
    "| Ref | Hypothesis | Claim | Stance | Rule | Provenance | Data origin | Retrieved |",
    "|---|---|---|---|---|---|---|---|",
    ...appendix.map(
      (a) =>
        `| ${a.label} | ${esc(a.hypothesisTitle)} | ${esc(a.claim)} | ${a.stance} | ${esc(a.rationale ?? a.evaluatorId)} | ${PROVENANCE_TEXT[a.provenanceClass] ?? a.provenanceClass} | ${originLabel(a)} | ${a.retrievedAt ?? "—"} |`,
    ),
    "",
    `_Exported by Tessaloom (${BLUEPRINT_VERSION}). Every evidence reference resolves to a stored, traceable evidence record._`,
    "",
  );
  return lines.join("\n");
}
