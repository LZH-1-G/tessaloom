import {
  Domain,
  type ClaimParams,
  type ClaimTestKind,
  type HypothesisDraft,
} from "@tessaloom/core";
import {
  ScriptedLlmProvider,
  type ProviderRequest,
  type ScriptedStep,
} from "@tessaloom/llm-gateway";

/**
 * Deterministic stand-ins for R1, R3, and R4 used when `LLM_PROVIDER=scripted` (development,
 * CI, browser E2E; refused in production). They read only the untrusted-input block, reference
 * entities by the UUIDs they were given, and produce schema-valid outputs. They are not a
 * model: the UI labels runs that used them as "Scripted AI".
 */

type El = { entityId: string; name: string; domain: string | null };
type PoolIn = { candidateId: string; rank: number | null; elements: El[] };

export function untrustedInput(
  request: ProviderRequest,
): Record<string, unknown> {
  const text = request.messages[0]?.content ?? "";
  const start = text.indexOf("<untrusted_input>");
  const end = text.lastIndexOf("</untrusted_input>");
  if (start < 0 || end < 0) return {};
  return JSON.parse(
    text.slice(start + "<untrusted_input>".length, end),
  ) as Record<string, unknown>;
}

const INSIGHT = new Set([
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
]);
const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

const GUESSES: [RegExp, string][] = [
  [/\b(film|films|movie|cinema|director)\b/i, "movie"],
  [/\b(series|show|sitcom|drama)\b/i, "tv_show"],
  [/\b(novel|novelist|book|books|author|poetry|fiction)\b/i, "book"],
  [/\b(band|music|musician|singer|album|records|dj)\b/i, "artist"],
  [/\b(podcast)\b/i, "podcast"],
  [/\b(video ?games?|game studio)\b/i, "videogame"],
];

function intent(input: Record<string, unknown>): ScriptedStep {
  const brief = input.brief as {
    interests: { text: string; domainHint?: string }[];
    venue: { type: string; localityText?: string; capacity?: number };
    constraints?: {
      budgetBand?: string;
      durationMinutes?: number;
      notes?: string[];
    };
    goals?: string[];
  };
  const interests = brief.interests.map((it, i) => ({
    text: it.text,
    guessedDomain:
      it.domainHint ??
      GUESSES.find(([re]) => re.test(it.text))?.[1] ??
      "unknown",
    importance: (i < 2 ? 3 : 2) as 1 | 2 | 3,
  }));
  const targets = [
    ...new Set([
      ...interests
        .map((i) => i.guessedDomain)
        .filter((d) => Domain.options.includes(d as never)),
      "book",
      "movie",
      "artist",
      "place",
    ]),
  ].slice(0, 6);
  const unknown = interests
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.guessedDomain === "unknown");
  return {
    output: {
      interests,
      targetDomains: targets,
      venue: {
        type: brief.venue.type,
        ...(brief.venue.localityText
          ? { locality: brief.venue.localityText }
          : {}),
        ...(brief.venue.capacity ? { capacity: brief.venue.capacity } : {}),
      },
      constraints: {
        ...(brief.constraints?.budgetBand
          ? { budgetBand: brief.constraints.budgetBand }
          : {}),
        ...(brief.constraints?.durationMinutes
          ? { durationMinutes: brief.constraints.durationMinutes }
          : {}),
        ...(brief.constraints?.notes?.length
          ? { notes: brief.constraints.notes }
          : {}),
      },
      goals: brief.goals ?? [],
      ambiguities: unknown.map(({ it, i }) => ({
        interestIndex: i,
        question: `Is "${clip(it.text, 60)}" a theme to search as a tag, or a specific title or artist?`,
      })),
      decisionSummary: clip(
        `Read ${interests.length} interests across ${new Set(interests.map((i) => i.guessedDomain)).size} worlds; ${unknown.length} need a closer look before searching Qloo.`,
        280,
      ),
    },
  };
}

function claimsFor(
  anchor: El,
  accent: El,
  seeds: El[],
  pool: PoolIn[],
  index: number,
  locality?: El | null,
): HypothesisDraft["claims"] {
  const entitySeeds = seeds.filter((s) => s.domain !== "tag");
  const tagSeeds = seeds.filter((s) => s.domain === "tag");
  const signals = (entitySeeds.length ? entitySeeds : [anchor])
    .slice(0, 2)
    .map((s) => s.entityId);
  const claims: {
    tempId: string;
    statement: string;
    testKind: ClaimTestKind;
    params: ClaimParams;
  }[] = [];
  if (accent.domain && INSIGHT.has(accent.domain))
    claims.push({
      tempId: "c1",
      statement: clip(
        `Audiences with affinity for the seeds also show affinity for ${accent.name} among ${accent.domain.replace("_", " ")} results.`,
        200,
      ),
      testKind: "CROSS_DOMAIN_AFFINITY",
      params: {
        signalEntityIds: signals,
        targetDomain: accent.domain as never,
        targetEntityId: accent.entityId,
      },
    });
  if (tagSeeds[0] && anchor.domain !== "tag")
    claims.push({
      tempId: "c2",
      statement: clip(
        `${anchor.name} carries the "${tagSeeds[0].name}" theme.`,
        200,
      ),
      testKind: "TAG_RESONANCE",
      params: {
        signalEntityIds: [anchor.entityId],
        tagEntityIds: [tagSeeds[0].entityId],
      },
    });
  else if (entitySeeds.length >= 2)
    claims.push({
      tempId: "c2",
      statement: clip(
        `The audiences of ${entitySeeds[0]!.name} and ${entitySeeds[1]!.name} share taste signals.`,
        200,
      ),
      testKind: "AUDIENCE_BRIDGE",
      params: {
        signalEntityIds: [entitySeeds[0]!.entityId],
        compareEntityIds: [entitySeeds[1]!.entityId],
      },
    });
  if (index % 2 === 0 && accent.domain && INSIGHT.has(accent.domain)) {
    const options = [
      ...new Map(
        pool
          .flatMap((p) => p.elements)
          .filter((e) => e.domain === accent.domain)
          .map((e) => [e.entityId, e]),
      ).values(),
    ].slice(0, 4);
    if (
      options.length >= 2 &&
      options.some((o) => o.entityId === accent.entityId)
    )
      claims.push({
        tempId: "c3",
        statement: clip(
          `${accent.name} leads a shortlist of ${accent.domain.replace("_", " ")} options for these audiences.`,
          200,
        ),
        testKind: "SHORTLIST_FIT",
        params: {
          signalEntityIds: signals.slice(0, 1),
          optionEntityIds: options.map((o) => o.entityId),
          targetEntityId: accent.entityId,
        },
      });
  }
  // Timeliness for screen media (trend series exist for film and TV; V1 finding 11).
  if (
    claims.length < 3 &&
    index % 2 === 1 &&
    (anchor.domain === "movie" || anchor.domain === "tv_show")
  )
    claims.push({
      tempId: "c4",
      statement: clip(`Interest in ${anchor.name} is rising right now.`, 200),
      testKind: "MOMENTUM",
      params: { signalEntityIds: [anchor.entityId] },
    });
  // Venue fit when the locality is resolved (LOCATION_FIT stays descriptive until calibrated).
  if (claims.length < 3 && locality && anchor.domain !== "tag")
    claims.push({
      tempId: "c5",
      statement: clip(
        `Audiences of ${anchor.name} concentrate around ${locality.name}.`,
        200,
      ),
      testKind: "LOCATION_FIT",
      params: { signalEntityIds: [anchor.entityId] },
    });
  return claims.slice(0, 3);
}

function generate(input: Record<string, unknown>): ScriptedStep {
  const seeds = (input.seeds as El[]) ?? [];
  const pool = (input.pool as PoolIn[]) ?? [];
  const limits = (input.limits as { maxHypotheses: number }) ?? {
    maxHypotheses: 6,
  };
  const brief = input.brief as {
    venue: { type: string; capacity?: number };
    constraints?: { durationMinutes?: number };
  };
  const hypotheses: HypothesisDraft[] = [];
  pool.slice(0, limits.maxHypotheses).forEach((candidate, index) => {
    const [x, y] = candidate.elements;
    if (!x || !y) return;
    const seedIds = new Set(seeds.map((s) => s.entityId));
    const anchor = seedIds.has(y.entityId) && !seedIds.has(x.entityId) ? y : x;
    const accent = anchor === x ? y : x;
    const claims = claimsFor(
      anchor,
      accent,
      seeds,
      pool,
      index,
      (input.venueLocality as El | undefined) ?? null,
    );
    if (claims.length === 0) return;
    hypotheses.push({
      tempId: `h${index + 1}`,
      title: clip(`${anchor.name} × ${accent.name}`, 80),
      premise: clip(
        `Audiences with affinity for ${anchor.name} may also show affinity for ${accent.name}; the pairing could anchor one evening across ${anchor.domain ?? "theme"} and ${accent.domain ?? "theme"} worlds.`,
        400,
      ),
      elementRefs: [
        { entityId: anchor.entityId, role: "anchor" },
        { entityId: accent.entityId, role: "accent" },
      ],
      claims,
      creativeElements: [
        {
          text: clip(
            `A ${accent.domain === "artist" ? "listening" : "browsing"} corner themed on ${accent.name}`,
            300,
          ),
          provenance: "CREATIVE_SPECULATION",
        },
      ],
      experienceSketch: clip(
        `A ${brief.constraints?.durationMinutes ?? 120}-minute ${brief.venue.type.replace("_", " ")} evening that pairs ${anchor.name} with ${accent.name}, with a short introduction and a shared table${brief.venue.capacity ? ` for up to ${brief.venue.capacity} guests` : ""}.`,
        600,
      ),
    });
  });
  return {
    output: {
      hypotheses,
      decisionSummary: clip(
        `Wove ${hypotheses.length} hypotheses from the top ${Math.min(pool.length, limits.maxHypotheses)} collision candidates.`,
        280,
      ),
    },
  };
}

function critique(input: Record<string, unknown>): ScriptedStep {
  const hyps =
    (input.hypotheses as {
      hypothesisId: string;
      status: string;
      claims: { evidence: { evidenceId: string; stance: string }[] }[];
    }[]) ?? [];
  const perHypothesis = hyps.map((h) => {
    const evidence = h.claims.flatMap((c) => c.evidence);
    const cited = evidence.slice(0, 3).map((e) => e.evidenceId);
    const recommendation =
      h.status === "SUPPORTED"
        ? "keep"
        : h.status === "CONTRADICTED"
          ? "retire"
          : "refine";
    return cited.length
      ? {
          hypothesisId: h.hypothesisId,
          confidenceNote: `Based on ${cited.length} aggregate affinity check${cited.length === 1 ? "" : "s"}; treat as directional.`,
          citedEvidenceIds: cited,
          recommendation,
          ...(recommendation === "refine"
            ? { refinementHint: "Test a different element of the pool." }
            : {}),
        }
      : {
          hypothesisId: h.hypothesisId,
          citedEvidenceIds: [],
          recommendation: "refine",
          refinementHint: "No evidence yet; choose a testable element.",
        };
  });
  return {
    output: {
      perHypothesis,
      continueLoop: perHypothesis.some((p) => p.recommendation === "refine"),
      decisionSummary: clip(
        `Reviewed ${hyps.length} hypotheses against their deterministic stances.`,
        280,
      ),
    },
  };
}

function revise(input: Record<string, unknown>): ScriptedStep {
  const hyps =
    (input.hypotheses as {
      hypothesisId: string;
      title: string;
      elements: { entityId: string; role: string }[];
      critique: { recommendation?: string } | null;
    }[]) ?? [];
  const seeds = (input.seeds as El[]) ?? [];
  const pool = (input.pool as PoolIn[]) ?? [];
  const byId = new Map(
    [...seeds, ...pool.flatMap((p) => p.elements)].map((e) => [e.entityId, e]),
  );
  const used = new Set(hyps.flatMap((h) => h.elements.map((e) => e.entityId)));
  const spare = [...byId.values()].filter(
    (e) => !used.has(e.entityId) && e.domain && INSIGHT.has(e.domain),
  );
  const refined: (HypothesisDraft & { revisionOfId: string })[] = [];
  const retiredIds: string[] = [];
  for (const h of hyps) {
    const rec = h.critique?.recommendation;
    if (rec === "retire") retiredIds.push(h.hypothesisId);
    if (rec !== "refine" || refined.length >= 3) continue;
    const anchor = byId.get(
      h.elements.find((e) => e.role === "anchor")?.entityId ?? "",
    );
    const accent = spare.shift();
    if (!anchor || !accent) continue;
    const signals = (
      seeds.filter((s) => s.domain !== "tag").length
        ? seeds.filter((s) => s.domain !== "tag")
        : [anchor]
    )
      .slice(0, 2)
      .map((s) => s.entityId);
    refined.push({
      revisionOfId: h.hypothesisId,
      tempId: `r${refined.length + 1}`,
      title: clip(`${anchor.name} × ${accent.name} (revised)`, 80),
      premise: clip(
        `A revised pairing: audiences with affinity for ${anchor.name} may also show affinity for ${accent.name}.`,
        400,
      ),
      elementRefs: [
        { entityId: anchor.entityId, role: "anchor" },
        { entityId: accent.entityId, role: "accent" },
      ],
      claims: [
        {
          tempId: "c1",
          statement: clip(
            `Seed audiences show affinity for ${accent.name} among ${accent.domain!.replace("_", " ")} results.`,
            200,
          ),
          testKind: "CROSS_DOMAIN_AFFINITY",
          params: {
            signalEntityIds: signals,
            targetDomain: accent.domain as never,
            targetEntityId: accent.entityId,
          },
        },
      ],
      creativeElements: [],
      experienceSketch: clip(
        `The same evening format, rebuilt around ${accent.name}.`,
        600,
      ),
    });
  }
  return {
    output: {
      refined,
      retiredIds,
      spawned: [],
      decisionSummary: clip(
        `Refined ${refined.length}, retired ${retiredIds.length}, spawned 0 hypotheses.`,
        280,
      ),
    },
  };
}

/** R5: a placeholder-only narrative over the deterministic metrics (WI-A4). */
function compareNarrative(input: Record<string, unknown>): ScriptedStep {
  const rescoreOnly = input.rescoreOnly === true;
  const hyps =
    (input.hypotheses as {
      title: string;
      from: string | null;
      to: string | null;
    }[]) ?? [];
  const claims = (input.claims as { evidenceIds: string[] }[]) ?? [];
  const lead = hyps[0];
  const parts = [
    rescoreOnly
      ? "Rescored with existing evidence, so no new Qloo data was retrieved."
      : "The branch re-ran {{metric:dirtyQueries}} Qloo queries and reused {{metric:reusedQueries}}.",
    "{{metric:changedStances}} of {{metric:claimsTotal}} claims changed stance; {{metric:changedStatuses}} of {{metric:hypothesesTotal}} hypotheses changed status.",
    ...(lead
      ? [
          lead.from === lead.to
            ? `"${lead.title.replace(/\d/g, "")}" stayed ${(lead.to ?? "untested").replace(/_/g, " ").toLowerCase()}, with its composite moving {{metric:h0.compositeDelta}}.`
            : `"${lead.title.replace(/\d/g, "")}" moved from ${(lead.from ?? "untested").replace(/_/g, " ").toLowerCase()} to ${(lead.to ?? "untested").replace(/_/g, " ").toLowerCase()} (composite {{metric:h0.compositeDelta}}).`,
        ]
      : []),
    "These are aggregate audience signals, not a verdict on creative fit.",
  ];
  return {
    output: {
      text: clip(parts.join(" "), 900),
      citedEvidenceIds: claims.flatMap((c) => c.evidenceIds).slice(0, 6),
      decisionSummary:
        "Explained the largest changes between parent and branch.",
    },
  };
}

const RESPONDERS: Record<
  string,
  (input: Record<string, unknown>) => ScriptedStep
> = {
  "r1.intent": intent,
  "r3.generate": generate,
  "r4.critique": critique,
  "r3.revise": revise,
  "r5.compare": compareNarrative,
};

/** A scripted provider that answers every prompt deterministically (and never runs out). */
export function createScriptedDemoProvider(): ScriptedLlmProvider {
  const provider = new ScriptedLlmProvider();
  const respond = (request: ProviderRequest): ScriptedStep => {
    const responder = RESPONDERS[request.promptId];
    if (!responder) return { text: "{}" };
    const step = responder(untrustedInput(request));
    // Re-queue so the next call to the same prompt is answered too.
    provider.on(request.promptId, respond);
    return step;
  };
  for (const id of Object.keys(RESPONDERS)) provider.on(id, respond);
  return provider;
}
