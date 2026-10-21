import type { BriefInput, EvidenceStance } from "@tessaloom/core";

/**
 * Rule-based feasibility (AGENT_WORKFLOW §16 step 6; ADR-025). Deterministic checks of the
 * concept text against the brief's own constraints — capacity, budget band, duration, venue
 * type — plus location evidence. Every applied rule is listed in the breakdown, so a score is
 * always explained. Unknown constraints are never penalized.
 */
export const FEASIBILITY_VERSION = "feasibility-1.0.0";

/** Formats and the smallest audience they plausibly need (craft-level heuristics). */
const CAPACITY_NEEDS: [RegExp, number, string][] = [
  [/\bfestival\b/i, 150, "festival"],
  [/\b(stadium|arena)\b/i, 1000, "arena event"],
  [/\b(concert|gig)\b/i, 80, "concert"],
  [/\b(full|symphony) orchestra\b/i, 120, "orchestra performance"],
  [/\blive band\b/i, 50, "live band"],
  [/\b(conference|summit|convention)\b/i, 100, "conference"],
  [/\b(dance floor|dance party|rave)\b/i, 50, "dance floor"],
  [/\b(night )?market\b/i, 80, "market"],
];
const COSTLY: [RegExp, string][] = [
  [/\b(headliner|celebrity|famous guest)\b/i, "headline talent"],
  [
    /\b(commissioned?|custom[- ]built|bespoke installation|installation)\b/i,
    "commissioned work",
  ],
  [/\b(full catering|catered dinner|tasting menu)\b/i, "catering"],
  [/\b(touring|tour)\b/i, "touring production"],
  [/\b(orchestra)\b/i, "orchestra"],
];
const MULTI_DAY =
  /\b(weekend[- ]long|multi[- ]day|all[- ]day|residency|week[- ]long|two[- ]day|three[- ]day)\b/i;
const PHYSICAL =
  /\b(tasting|in[- ]person|dance floor|screening room|walking tour|food stall)\b/i;

export interface FeasibilityRule {
  rule: "CAPACITY" | "BUDGET" | "DURATION" | "VENUE" | "LOCATION_EVIDENCE";
  effect: number; // negative = penalty
  detail: string;
}

export interface Feasibility {
  score: number; // 0..1
  rules: FeasibilityRule[];
  version: string;
}

export function assessFeasibility(input: {
  text: string; // title + premise + sketch + creative elements
  brief: Pick<BriefInput, "venue" | "constraints">;
  locationStances: (EvidenceStance | null)[];
}): Feasibility {
  const rules: FeasibilityRule[] = [];
  const { venue, constraints } = input.brief;
  if (venue.capacity) {
    const needs = CAPACITY_NEEDS.filter(([re]) => re.test(input.text)).sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (needs && needs[1] > venue.capacity)
      rules.push({
        rule: "CAPACITY",
        effect: -0.3,
        detail: `A ${needs[2]} usually needs ~${needs[1]}+ people; the venue holds ${venue.capacity}`,
      });
  }
  if (constraints.budgetBand === "low") {
    const costly = COSTLY.filter(([re]) => re.test(input.text)).map(
      ([, label]) => label,
    );
    if (costly.length)
      rules.push({
        rule: "BUDGET",
        effect: -0.2,
        detail: `A low budget conflicts with ${[...new Set(costly)].join(", ")}`,
      });
  }
  if (
    constraints.durationMinutes &&
    constraints.durationMinutes < 240 &&
    MULTI_DAY.test(input.text)
  )
    rules.push({
      rule: "DURATION",
      effect: -0.2,
      detail: `A multi-day format exceeds the ${constraints.durationMinutes}-minute slot`,
    });
  if (venue.type === "online" && PHYSICAL.test(input.text))
    rules.push({
      rule: "VENUE",
      effect: -0.2,
      detail: "The concept needs a physical space; the venue is online",
    });
  if (input.locationStances.includes("SUPPORTS"))
    rules.push({
      rule: "LOCATION_EVIDENCE",
      effect: 0.1,
      detail: "Location evidence supports the venue's area",
    });
  // Base 0.8: a concept that passes every check is plausible, not proven.
  const score = Math.max(
    0.1,
    Math.min(1, 0.8 + rules.reduce((sum, r) => sum + r.effect, 0)),
  );
  return {
    score: Math.round(score * 1000) / 1000,
    rules,
    version: FEASIBILITY_VERSION,
  };
}
