import { describe, expect, it } from "vitest";
import {
  buildCollisionCandidates,
  selectPool,
  type ThreadItem,
} from "../../packages/core/src";

/**
 * CC-A1…CC-A4 (TEST_PLAN §12.2) on an S2-like fixture ("Low-Fi Lounge": a music seed, a
 * video-game seed, and a coffee tag seed threaded into book, movie, place, and artist).
 */
const DOMAINS = ["book", "movie", "place", "artist", "videogame"];
const seeds = [
  { entityId: "S-music", domain: "artist" },
  { entityId: "S-game", domain: "videogame" },
  { entityId: "S-coffee", domain: "tag" },
];
const item = (d: string, n: number) => `${d}-${n}`;
const threads = new Map<string, ThreadItem[]>(
  seeds.map((seed, si) => [
    seed.entityId,
    DOMAINS.filter((d) => d !== seed.domain).flatMap((domain) =>
      // Overlapping windows create co-occurrence across seeds' threads.
      Array.from({ length: 10 }, (_, position) => ({
        entityId: item(domain, (position + si * 4) % 16),
        domain,
        position,
      })),
    ),
  ]),
);
const TAGS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
const tags = new Map<string, string[]>();
for (const domain of DOMAINS)
  for (let n = 0; n < 16; n++)
    tags.set(
      item(domain, n),
      TAGS.filter((_, i) => (n + i * 3 + domain.length) % 5 < 2),
    );
for (const s of seeds) tags.set(s.entityId, ["t1", "t2"]);

const candidates = () =>
  buildCollisionCandidates({ seeds, threads, tags, k: 10 });

describe("Cultural Collision Engine", () => {
  it("CC-A1: the same inputs give an identical pool (ids and order) across 10 runs", () => {
    const first = selectPool(candidates(), 0.5);
    expect(first.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 10; i++)
      expect(selectPool(candidates(), 0.5)).toEqual(first);
    // Input order does not matter either.
    const reversed = new Map(
      [...threads.entries()].reverse().map(([k, v]) => [k, [...v].reverse()]),
    );
    expect(
      selectPool(
        buildCollisionCandidates({
          seeds: [...seeds].reverse(),
          threads: reversed,
          tags,
          k: 10,
        }),
        0.5,
      ),
    ).toEqual(first);
  });

  it("CC-A2: τ 0.3 vs 0.8 changes at least 30% of the pool", () => {
    const all = candidates();
    const harmonious = new Set(selectPool(all, 0.3).map((s) => s.key));
    const unexpected = selectPool(all, 0.8).map((s) => s.key);
    const differing = unexpected.filter((k) => !harmonious.has(k)).length;
    expect(differing / unexpected.length).toBeGreaterThanOrEqual(0.3);
  });

  it("CC-A3: no two selected candidates share the same domain pair", () => {
    const byKey = new Map(candidates().map((c) => [c.key, c]));
    for (const tau of [0.2, 0.3, 0.5, 0.8, 0.9]) {
      const pairs = selectPool([...byKey.values()], tau).map((s) =>
        [...byKey.get(s.key)!.domains].sort().join("|"),
      );
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  it("CC-A4: without tags every candidate is flagged REDUCED_INPUTS and scored by domain distance only", () => {
    const reduced = buildCollisionCandidates({
      seeds,
      threads,
      tags: new Map(),
      k: 10,
    });
    expect(reduced.length).toBeGreaterThan(0);
    for (const c of reduced) {
      expect(c.noveltyInputs).toBe("REDUCED_INPUTS");
      expect(c.breakdown.tagJaccard).toBeNull();
      expect([0.45, 0.75]).toContain(c.novelty);
    }
    const full = candidates();
    expect(full.some((c) => c.noveltyInputs === "FULL")).toBe(true);
  });

  it("scores are bounded and explained; bridges need two seeds and a co-occurrence or shared tag", () => {
    for (const c of candidates()) {
      for (const v of [c.relevance, c.novelty]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(c.bridge.seeds.length).toBeGreaterThanOrEqual(2);
      expect(c.bridge.coOccurrence || c.bridge.sharedTagIds.length > 0).toBe(
        true,
      );
      expect(c.domains[0]).not.toBe(c.domains[1]);
    }
    // A single seed's thread alone never forms a candidate.
    const lonely = buildCollisionCandidates({
      seeds: seeds.slice(0, 1),
      threads: new Map([
        [seeds[0]!.entityId, threads.get(seeds[0]!.entityId)!],
      ]),
      tags,
      k: 10,
    });
    expect(lonely).toEqual([]);
  });

  it("keeps the top k per domain and clamps τ to the slider range", () => {
    const k3 = buildCollisionCandidates({ seeds, threads, tags, k: 3 });
    const ids = new Set(k3.flatMap((c) => c.elementEntityIds));
    for (const [, thread] of threads)
      for (const t of thread.filter((x) => x.position >= 3)) {
        const elsewhere = [...threads.values()]
          .flat()
          .some((x) => x.entityId === t.entityId && x.position < 3);
        if (!elsewhere) expect(ids.has(t.entityId)).toBe(false);
      }
    expect(selectPool(candidates(), 5)).toEqual(selectPool(candidates(), 0.9));
  });
});
