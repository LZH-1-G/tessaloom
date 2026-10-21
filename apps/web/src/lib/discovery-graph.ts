import type { EntityView, ExperimentViewData, RelationView } from "./types";

export interface GraphEntity {
  entity: EntityView;
  lane: string;
  isSeed: boolean;
  bestPosition: number;
  seeds: string[]; // seed entity ids whose threads contain it
  tags: EntityView[];
  facts: RelationView[];
}

export interface DiscoveryGraph {
  lanes: string[];
  entities: Map<string, GraphEntity>;
  threads: RelationView[];
  seeds: EntityView[];
  location: EntityView | null;
}

/** Lanes (warp) are domains; seeds sit on top; thread items follow Qloo's result order. */
export function buildDiscoveryGraph(view: ExperimentViewData): DiscoveryGraph {
  const byId = new Map(view.entities.map((e) => [e.id, e]));
  const seedIds = view.seeds
    .filter((s) => s.role === "seed")
    .map((s) => s.entityId);
  const seeds = seedIds
    .map((id) => byId.get(id))
    .filter((e): e is EntityView => !!e);
  const locationId = view.seeds.find((s) => s.role === "location")?.entityId;
  const threads = view.relations.filter((r) => r.kind === "THREAD");
  const hasTag = view.relations.filter((r) => r.kind === "HAS_TAG");
  const entities = new Map<string, GraphEntity>();
  const ensure = (e: EntityView, isSeed: boolean) => {
    const existing = entities.get(e.id);
    if (existing) return existing;
    const node: GraphEntity = {
      entity: e,
      lane: e.domain ?? "unknown",
      isSeed,
      bestPosition: isSeed ? -1 : Number.POSITIVE_INFINITY,
      seeds: [],
      tags: hasTag
        .filter((r) => r.fromEntityId === e.id)
        .map((r) => byId.get(r.toEntityId))
        .filter((t): t is EntityView => !!t),
      facts: [],
    };
    entities.set(e.id, node);
    return node;
  };
  for (const s of seeds) ensure(s, true);
  for (const r of threads) {
    const target = byId.get(r.toEntityId);
    if (!target) continue;
    const node = ensure(target, seedIds.includes(target.id));
    const position = Math.round((1 - (r.weight ?? 0)) * 10);
    if (!node.isSeed) node.bestPosition = Math.min(node.bestPosition, position);
    if (!node.seeds.includes(r.fromEntityId)) node.seeds.push(r.fromEntityId);
    node.facts.push(r);
  }
  const order = [
    ...new Set([
      ...seeds.map((s) => s.domain ?? "unknown"),
      ...view.experiment.definition.variables.targetDomains,
    ]),
  ];
  const lanes = order.filter((lane) =>
    [...entities.values()].some((n) => n.lane === lane),
  );
  return {
    lanes,
    entities,
    threads,
    seeds,
    location: locationId ? (byId.get(locationId) ?? null) : null,
  };
}

export function laneItems(graph: DiscoveryGraph, lane: string): GraphEntity[] {
  return [...graph.entities.values()]
    .filter((n) => n.lane === lane)
    .sort(
      (a, b) =>
        a.bestPosition - b.bestPosition ||
        b.seeds.length - a.seeds.length ||
        a.entity.name.localeCompare(b.entity.name),
    );
}
