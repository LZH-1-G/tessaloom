/**
 * Cultural Collision Engine (AGENT_WORKFLOW §16), deterministic. M4 implements threads,
 * co-occurrence/shared-tag bridges, scoring, and MMR selection; M6 calibrates and extends.
 */
export interface ThreadItem {
  entityId: string;
  domain: string;
  position: number; // 0-based rank in the seed's recommend result
  tagIds: string[];
}

export interface CollisionSeed {
  entityId: string;
  domain: string;
  tagIds: string[];
}

export interface CollisionCandidate {
  elementEntityIds: [string, string];
  relevance: number;
  novelty: number;
  tensionFit: number;
  noveltyInputs: "FULL" | "REDUCED_INPUTS";
  bridge: { sharedTagIds: string[]; coOccurrence: boolean };
  selected: boolean;
  rank: number | null;
}

const CLASS: Record<string, string> = {
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
};

const round = (v: number) => Math.round(v * 10_000) / 10_000;

export function buildCollisionPool(input: {
  seeds: CollisionSeed[];
  threads: ReadonlyMap<string, ThreadItem[]>; // seed entityId → items across target domains
  k?: number;
  tension: number; // τ in [0.2, 0.9]
  maxPool?: number;
}): CollisionCandidate[] {
  const k = input.k ?? 10;
  const maxPool = input.maxPool ?? 12;
  type El = {
    entityId: string;
    domain: string;
    tagIds: Set<string>;
    seeds: Set<string>;
    weight: number;
  };
  const elements = new Map<string, El>();
  const add = (
    id: string,
    domain: string,
    tags: string[],
    seed: string,
    weight: number,
  ) => {
    const el = elements.get(id) ?? {
      entityId: id,
      domain,
      tagIds: new Set<string>(),
      seeds: new Set<string>(),
      weight: 0,
    };
    tags.forEach((t) => el.tagIds.add(t));
    el.seeds.add(seed);
    el.weight = Math.max(el.weight, weight);
    elements.set(id, el);
  };
  for (const seed of input.seeds)
    add(seed.entityId, seed.domain, seed.tagIds, seed.entityId, 1);
  // A seed's thread spans several target domains; keep the top k of each domain by rank.
  for (const [seedId, thread] of input.threads)
    for (const item of thread.filter((i) => i.position < k))
      add(
        item.entityId,
        item.domain,
        item.tagIds,
        seedId,
        1 - item.position / k,
      );

  const list = [...elements.values()].sort((a, b) =>
    a.entityId.localeCompare(b.entityId),
  );
  const candidates: CollisionCandidate[] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i]!;
      const y = list[j]!;
      if (x.domain === y.domain) continue;
      const seedsCovered = new Set([...x.seeds, ...y.seeds]);
      if (seedsCovered.size < 2) continue; // elements must come from different seeds' threads
      const shared = [...x.tagIds].filter((t) => y.tagIds.has(t));
      const coOccurrence = [...x.seeds].some((s) => y.seeds.has(s));
      if (shared.length === 0 && !coOccurrence) continue; // not a bridge
      const tagsKnown = x.tagIds.size > 0 && y.tagIds.size > 0;
      const distance = CLASS[x.domain] !== CLASS[y.domain] ? 0.3 : 0.1;
      let novelty: number;
      if (tagsKnown) {
        const union = new Set([...x.tagIds, ...y.tagIds]).size;
        novelty = Math.min(1, 1 - shared.length / union + distance * 0.5);
      } else novelty = 0.4 + distance;
      const relevance = (x.weight + y.weight) / 2;
      candidates.push({
        elementEntityIds: [x.entityId, y.entityId],
        relevance: round(relevance),
        novelty: round(novelty),
        tensionFit: round(1 - Math.abs(novelty - input.tension)),
        noveltyInputs: tagsKnown ? "FULL" : "REDUCED_INPUTS",
        bridge: { sharedTagIds: shared.sort(), coOccurrence },
        selected: false,
        rank: null,
      });
    }

  // Maximal Marginal Relevance with a diversity penalty for reused elements and domain pairs.
  const domainOf = (id: string) => elements.get(id)!.domain;
  const pairKey = (c: CollisionCandidate) =>
    c.elementEntityIds.map(domainOf).sort().join("|");
  const remainingSet = [...candidates];
  const usedPairs = new Set<string>();
  const usedElements = new Map<string, number>();
  let rank = 1;
  while (rank <= maxPool && remainingSet.length > 0) {
    let best = -1;
    let bestScore = -Infinity;
    remainingSet.forEach((c, idx) => {
      if (usedPairs.has(pairKey(c)) && rank <= maxPool / 2) return; // prefer new domain pairs first
      const reuse = c.elementEntityIds.reduce(
        (n, id) => n + (usedElements.get(id) ?? 0),
        0,
      );
      const score = 0.5 * c.relevance + 0.5 * c.tensionFit - 0.15 * reuse;
      if (
        score > bestScore ||
        (score === bestScore &&
          best >= 0 &&
          c.elementEntityIds.join() <
            remainingSet[best]!.elementEntityIds.join())
      ) {
        best = idx;
        bestScore = score;
      }
    });
    if (best < 0) {
      // Only repeated domain pairs remain in the first half: allow them.
      if (rank <= maxPool / 2 && remainingSet.length > 0) {
        usedPairs.clear();
        continue;
      }
      break;
    }
    const [chosen] = remainingSet.splice(best, 1);
    chosen!.selected = true;
    chosen!.rank = rank++;
    usedPairs.add(pairKey(chosen!));
    chosen!.elementEntityIds.forEach((id) =>
      usedElements.set(id, (usedElements.get(id) ?? 0) + 1),
    );
  }
  return candidates;
}
