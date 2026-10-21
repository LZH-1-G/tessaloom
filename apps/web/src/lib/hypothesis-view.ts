import type { ClaimRow, EntityView, HypothesisRow } from "./types";

/** Board order (UI_UX_SPEC §4.4). Retired and superseded versions go to a collapsed group. */
export const STATUS_ORDER = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNDER_INVESTIGATION",
  "SPECULATIVE",
  "INCONCLUSIVE",
  "CONTRADICTED",
  "UNTESTABLE",
] as const;

export interface HypothesisGroups {
  active: { status: string; items: HypothesisRow[] }[];
  /** Retired by the critic or the reviser; honest negative results stay visible (HL-A5). */
  retired: { hypothesis: HypothesisRow; supersededBy: HypothesisRow | null }[];
}

export function groupHypotheses(hyps: HypothesisRow[]): HypothesisGroups {
  const successor = new Map(
    hyps.filter((h) => h.revisionOfId).map((h) => [h.revisionOfId!, h]),
  );
  const live = hyps
    .filter((h) => !h.retired)
    .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
  const statuses = [
    ...STATUS_ORDER,
    ...new Set(
      live
        .map((h) => h.status)
        .filter((s) => !(STATUS_ORDER as readonly string[]).includes(s)),
    ),
  ];
  return {
    active: statuses
      .map((status) => ({
        status,
        items: live.filter((h) => h.status === status),
      }))
      .filter((g) => g.items.length),
    retired: hyps
      .filter((h) => h.retired)
      .sort((a, b) => b.iteration - a.iteration)
      .map((h) => ({
        hypothesis: h,
        supersededBy: successor.get(h.id) ?? null,
      })),
  };
}

export interface TimelineStep {
  iteration: number;
  woven: number;
  refined: number;
  spawned: number;
}

/**
 * "Iteration 1 → 2 → 3" with what changed. Iteration 1 weaves; later ones refine or spawn.
 * Stored iterations are 0-based (the run's counter); they are shown 1-based like the dock.
 */
export function iterationTimeline(hyps: HypothesisRow[]): TimelineStep[] {
  if (!hyps.length) return [];
  const max = Math.max(...hyps.map((h) => h.iteration)) + 1;
  return Array.from({ length: max }, (_, i) => {
    const at = hyps.filter((h) => h.iteration === i);
    const refined = at.filter((h) => h.revisionOfId).length;
    return {
      iteration: i + 1,
      woven: i === 0 ? at.length : 0,
      refined,
      spawned: i === 0 ? 0 : at.length - refined,
    };
  });
}

export function stanceCounts(h: HypothesisRow) {
  const counts = {
    SUPPORTS: 0,
    CONTRADICTS: 0,
    NEUTRAL: 0,
    INSUFFICIENT: 0,
    untested: 0,
  };
  for (const c of h.claims) {
    if (c.currentStance) counts[c.currentStance] += 1;
    else counts.untested += 1;
  }
  return counts;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const DOMAIN_NOUN: Record<string, string> = {
  artist: "music artists",
  book: "books",
  brand: "brands",
  destination: "destinations",
  movie: "films",
  person: "people",
  place: "places",
  podcast: "podcasts",
  tv_show: "TV shows",
  videogame: "video games",
};

/**
 * The claim's test kind as a plain-language question (UI_UX_SPEC §4.4). Built only from the
 * typed parameters, so it says exactly what the evaluator checks — no more.
 */
export function testQuestion(
  claim: ClaimRow,
  entities: Map<string, EntityView>,
): string {
  const p = claim.testParams as {
    signalEntityIds?: string[];
    targetDomain?: string;
    targetEntityId?: string;
    tagEntityIds?: string[];
    optionEntityIds?: string[];
  };
  const name = (id?: string) =>
    id ? (entities.get(id)?.name ?? "an entity") : "";
  const signals = list((p.signalEntityIds ?? []).map(name));
  const domain = p.targetDomain
    ? (DOMAIN_NOUN[p.targetDomain] ?? p.targetDomain)
    : "results";
  const tags = list((p.tagEntityIds ?? []).map(name));
  switch (claim.testKind) {
    case "CROSS_DOMAIN_AFFINITY":
      return p.targetEntityId
        ? `Does ${name(p.targetEntityId)} rank high among ${domain} recommended for fans of ${signals}?`
        : `Do fans of ${signals} also favor ${tags ? `${tags}-tagged ` : ""}${domain}?`;
    case "SHORTLIST_FIT":
      return `Which of ${list((p.optionEntityIds ?? []).map(name))} sits highest for fans of ${signals}?`;
    case "AUDIENCE_BRIDGE":
      return `Do ${signals} share tags or an audience in Qloo's data?`;
    case "TAG_RESONANCE":
      return `Which descriptive tags does Qloo attach to ${signals}${tags ? ` — including ${tags}?` : "?"}`;
    case "LOCATION_FIT":
      return `Is there affinity for ${signals} around the venue's locality?`;
    case "MOMENTUM":
      return `Is interest in ${signals} rising or falling recently?`;
    case "AUDIENCE_PROFILE":
      return `What does the audience of ${signals} look like? (descriptive only)`;
    default:
      return claim.statement;
  }
}

export interface Breakdown {
  testedClaims?: number;
  supportRaw?: number;
  weightSupport?: number;
  weightNovelty?: number;
  weightFeasibility?: number;
  scoringVersion?: string;
  noveltyInputs?: "FULL" | "REDUCED_INPUTS";
  feasibility?: {
    version: string;
    rules: { rule: string; effect: number; detail: string }[];
  };
  critique?: {
    recommendation: string;
    confidenceNote: string | null;
    downgrade: string | null;
    citedEvidenceIds: string[];
    refinementHint: string | null;
  };
}

export const breakdownOf = (h: HypothesisRow) =>
  (h.scoreBreakdown ?? {}) as Breakdown;
