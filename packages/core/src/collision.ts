/**
 * Cultural Collision Engine (AGENT_WORKFLOW §16). Pure and deterministic, and shared by the
 * worker (pool building) and the browser (the Collision Tension slider re-selects the pool
 * client-side from stored scores; UI_UX_SPEC §4.3). ADR-024.
 */

export const COLLISION_VERSION = "collision-1.0.0";

/** Domain classes for the distance bonus: media ↔ place ↔ product ↔ person ↔ tag. */
const DOMAIN_CLASS: Record<string, string> = {
  movie: "media",
  tv_show: "media",
  book: "media",
  podcast: "media",
  artist: "media",
  videogame: "media",
  place: "place",
  destination: "place",
  brand: "product",
  person: "person",
  tag: "tag",
};
export const domainClass = (domain: string) => DOMAIN_CLASS[domain] ?? domain;

export interface ThreadItem {
  entityId: string;
  domain: string;
  position: number; // 0-based rank within one (seed, target domain) recommend result
}

export interface CollisionSeed {
  entityId: string;
  domain: string; // "tag" for tag seeds
}

export interface CandidateBridge {
  sharedTagIds: string[];
  coOccurrence: boolean;
  /** Seeds whose threads contain both elements (co-occurrence) or either element. */
  seeds: string[];
}

export interface PoolCandidate {
  key: string; // sorted element ids joined by "|": stable identity across τ
  elementEntityIds: [string, string];
  domains: [string, string];
  relevance: number; // 0..1, Qloo-derived ordering (position-weighted presence)
  novelty: number; // 0..1
  noveltyInputs: "FULL" | "REDUCED_INPUTS";
  bridge: CandidateBridge;
  breakdown: {
    relevanceX: number;
    relevanceY: number;
    tagJaccard: number | null;
    domainDistance: number;
  };
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Build every bridge candidate (§16 steps 1–3) without τ: tension only affects selection,
 * so the slider can re-select instantly from these stored scores.
 */
export function buildCollisionCandidates(input: {
  seeds: CollisionSeed[];
  /** seed entityId → thread items across target domains. */
  threads: ReadonlyMap<string, ThreadItem[]>;
  /** entityId → tag ids; a missing entry means tags are unknown (REDUCED_INPUTS). */
  tags: ReadonlyMap<string, readonly string[]>;
  k?: number;
  maxPerDomainPair?: number;
}): PoolCandidate[] {
  const k = input.k ?? 10;
  const seedCount = Math.max(1, input.seeds.length);
  type El = {
    entityId: string;
    domain: string;
    seeds: Set<string>;
    presence: number;
  };
  const elements = new Map<string, El>();
  const touch = (id: string, domain: string, seed: string, weight: number) => {
    const el = elements.get(id) ?? {
      entityId: id,
      domain,
      seeds: new Set<string>(),
      presence: 0,
    };
    if (!el.seeds.has(seed)) {
      el.seeds.add(seed);
      // Normalized position-weighted presence: Σ over seeds of (1 − pos/k), divided by #seeds.
      el.presence = Math.min(1, el.presence + weight / seedCount);
    }
    elements.set(id, el);
  };
  for (const seed of input.seeds) {
    const el = elements.get(seed.entityId) ?? {
      entityId: seed.entityId,
      domain: seed.domain,
      seeds: new Set<string>(),
      presence: 1,
    };
    el.seeds.add(seed.entityId);
    el.presence = 1;
    elements.set(seed.entityId, el);
  }
  for (const [seedId, thread] of input.threads)
    for (const item of thread)
      if (item.position < k)
        touch(item.entityId, item.domain, seedId, 1 - item.position / k);

  const list = [...elements.values()].sort((a, b) =>
    a.entityId < b.entityId ? -1 : 1,
  );
  const byPair = new Map<string, PoolCandidate[]>();
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i]!;
      const y = list[j]!;
      if (x.domain === y.domain) continue;
      const covered = new Set([...x.seeds, ...y.seeds]);
      if (covered.size < 2) continue; // the elements must come from different seeds' threads
      const tx = input.tags.get(x.entityId);
      const ty = input.tags.get(y.entityId);
      const shared = tx && ty ? tx.filter((t) => ty.includes(t)).sort() : [];
      const coOccurrence = [...x.seeds].some((s) => y.seeds.has(s));
      if (shared.length === 0 && !coOccurrence) continue; // not a bridge
      const distance =
        domainClass(x.domain) !== domainClass(y.domain) ? 1 : 0.4;
      const tagsKnown = !!tx?.length && !!ty?.length;
      let jaccard: number | null = null;
      let novelty: number;
      if (tagsKnown) {
        jaccard = shared.length / new Set([...tx!, ...ty!]).size;
        novelty = 0.7 * (1 - jaccard) + 0.3 * distance;
      } else {
        // Without tags, novelty is domain distance only and flagged (CC-5, CC-A4).
        novelty = distance === 1 ? 0.75 : 0.45;
      }
      const pairKey = [x.domain, y.domain].sort().join("|");
      const candidate: PoolCandidate = {
        key: `${x.entityId}|${y.entityId}`,
        elementEntityIds: [x.entityId, y.entityId],
        domains: [x.domain, y.domain],
        relevance: round((x.presence + y.presence) / 2),
        novelty: round(novelty),
        noveltyInputs: tagsKnown ? "FULL" : "REDUCED_INPUTS",
        bridge: {
          sharedTagIds: shared,
          coOccurrence,
          seeds: [...covered].sort(),
        },
        breakdown: {
          relevanceX: round(x.presence),
          relevanceY: round(y.presence),
          tagJaccard: jaccard === null ? null : round(jaccard),
          domainDistance: distance,
        },
      };
      const list2 = byPair.get(pairKey) ?? [];
      list2.push(candidate);
      byPair.set(pairKey, list2);
    }
  // Keep the strongest candidates of each domain pair across the novelty range, so every τ
  // still finds its best fit after the cap.
  const cap = input.maxPerDomainPair ?? 40;
  const out: PoolCandidate[] = [];
  for (const pair of [...byPair.keys()].sort()) {
    const group = byPair
      .get(pair)!
      .sort((a, b) => b.relevance - a.relevance || (a.key < b.key ? -1 : 1));
    if (group.length <= cap) out.push(...group);
    else {
      const byNovelty = [...group].sort(
        (a, b) => b.novelty - a.novelty || (a.key < b.key ? -1 : 1),
      );
      const keep = new Map<string, PoolCandidate>();
      for (const c of group.slice(0, cap / 2)) keep.set(c.key, c);
      for (const c of byNovelty.slice(0, cap / 4)) keep.set(c.key, c);
      for (const c of byNovelty.slice(-cap / 4)) keep.set(c.key, c);
      out.push(
        ...[...keep.values()].sort(
          (a, b) => b.relevance - a.relevance || (a.key < b.key ? -1 : 1),
        ),
      );
    }
  }
  return out;
}

export interface PoolSelection {
  key: string;
  rank: number;
  tensionFit: number;
  score: number;
}

/** τ from the Collision Tension slider: Harmonious (0.2) ↔ Unexpected (0.9). */
export const TENSION_MIN = 0.2;
export const TENSION_MAX = 0.9;

/**
 * §16 step 4: Maximal Marginal Relevance over 0.5·relevance + 0.5·tensionFit, with
 * tensionFit = 1 − |novelty − τ|. Diversity is strict: no two selected candidates share
 * the same domain pair (CC-A3), and reusing an element costs 0.15 per earlier use.
 */
export function selectPool(
  candidates: readonly Pick<
    PoolCandidate,
    "key" | "elementEntityIds" | "domains" | "relevance" | "novelty"
  >[],
  tension: number,
  maxPool = 12,
): PoolSelection[] {
  const tau = Math.min(TENSION_MAX, Math.max(TENSION_MIN, tension));
  const fit = (n: number) => round(1 - Math.abs(n - tau));
  const remaining = [...candidates];
  const usedPairs = new Set<string>();
  const uses = new Map<string, number>();
  const selected: PoolSelection[] = [];
  while (selected.length < maxPool) {
    let best: (typeof remaining)[number] | null = null;
    let bestScore = -Infinity;
    for (const c of remaining) {
      if (usedPairs.has([...c.domains].sort().join("|"))) continue;
      const reuse = c.elementEntityIds.reduce(
        (n, id) => n + (uses.get(id) ?? 0),
        0,
      );
      const score = 0.5 * c.relevance + 0.5 * fit(c.novelty) - 0.15 * reuse;
      if (
        score > bestScore + 1e-12 ||
        (Math.abs(score - bestScore) <= 1e-12 && best && c.key < best.key)
      ) {
        best = c;
        bestScore = score;
      }
    }
    if (!best) break;
    remaining.splice(remaining.indexOf(best), 1);
    usedPairs.add([...best.domains].sort().join("|"));
    best.elementEntityIds.forEach((id) =>
      uses.set(id, (uses.get(id) ?? 0) + 1),
    );
    selected.push({
      key: best.key,
      rank: selected.length + 1,
      tensionFit: fit(best.novelty),
      score: round(bestScore),
    });
  }
  return selected;
}
