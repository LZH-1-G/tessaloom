import type { EvidenceGraph, GraphNode, GraphNodeType } from "@tessaloom/core";

export const COLUMN_X: Record<GraphNodeType, number> = {
  entity: 0,
  hypothesis: 330,
  claim: 680,
  evidence: 1040,
};
const GAP: Record<GraphNodeType, number> = {
  entity: 72,
  hypothesis: 120,
  claim: 74,
  evidence: 54,
};

/**
 * Deterministic layered layout: entities → hypotheses → claims → evidence (left to right, the
 * way evidence is built). Claims are stacked per hypothesis; hypotheses sit beside their
 * claims; evidence aligns with its claim; entities sit beside the hypotheses that use them.
 * Saved positions (graph_layouts) override the computed ones.
 */
export function layoutGraph(
  graph: Pick<EvidenceGraph, "nodes" | "edges">,
  saved: Record<string, { x: number; y: number }> | null = null,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const byType = (t: GraphNodeType) => graph.nodes.filter((n) => n.type === t);
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const e of graph.edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    into.set(e.target, [...(into.get(e.target) ?? []), e.source]);
  }
  const hyps = byType("hypothesis").sort(
    (a, b) =>
      Number(b.data.composite ?? -1) - Number(a.data.composite ?? -1) ||
      a.id.localeCompare(b.id),
  );
  const claimsOf = (h: GraphNode) =>
    byType("claim")
      .filter((c) => c.data.hypothesisId === h.id)
      .sort((a, b) => Number(a.data.ordinal) - Number(b.data.ordinal));

  let y = 0;
  for (const h of hyps) {
    const claims = claimsOf(h);
    const start = y;
    for (const c of claims) {
      pos.set(c.id, { x: COLUMN_X.claim, y });
      const evidence = (out.get(c.id) ?? []).filter((id) =>
        graph.nodes.some((n) => n.id === id && n.type === "evidence"),
      );
      evidence.forEach((id, i) =>
        pos.set(id, { x: COLUMN_X.evidence, y: y + i * GAP.evidence }),
      );
      y += Math.max(GAP.claim, evidence.length * GAP.evidence);
    }
    const end = claims.length ? y - GAP.claim : y;
    pos.set(h.id, { x: COLUMN_X.hypothesis, y: (start + end) / 2 });
    y = Math.max(y, start + GAP.hypothesis) + 28;
  }

  // Entities: beside the mean of their connected hypotheses/evidence, then de-overlapped.
  const entities = byType("entity").map((n) => {
    // Beside the hypotheses that use the entity (ELEMENT_OF), else beside citing claims.
    const linked = [...(out.get(n.id) ?? []), ...(into.get(n.id) ?? [])];
    const hypsOf = linked.filter((id) =>
      graph.nodes.some((x) => x.id === id && x.type === "hypothesis"),
    );
    const ys = (hypsOf.length ? hypsOf : linked)
      .map((id) => pos.get(id)?.y)
      .filter((v): v is number => v !== undefined);
    const seed = n.data.seed ? -1 : 0;
    return {
      id: n.id,
      want: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity,
      seed,
    };
  });
  // Connected entities sit beside their hypotheses (de-overlapped top to bottom); entities
  // nothing links to (for example an unused seed) stack above the graph.
  const linked = entities
    .filter((e) => Number.isFinite(e.want))
    .sort(
      (a, b) => a.want - b.want || a.seed - b.seed || a.id.localeCompare(b.id),
    );
  const loose = entities
    .filter((e) => !Number.isFinite(e.want))
    .sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
  let last = -Infinity;
  for (const e of linked) {
    const placed = Math.max(e.want, last + GAP.entity);
    pos.set(e.id, { x: COLUMN_X.entity, y: placed });
    last = placed;
  }
  const top = linked.length ? pos.get(linked[0]!.id)!.y : 0;
  loose.forEach((e, i) =>
    pos.set(e.id, {
      x: COLUMN_X.entity,
      y: top - (loose.length - i) * GAP.entity,
    }),
  );
  if (saved)
    for (const [id, p] of Object.entries(saved))
      if (pos.has(id)) pos.set(id, p);
  return pos;
}

/**
 * Arrow-key navigation (UI_UX_SPEC §8): Right follows an outgoing edge, Left an incoming one,
 * Up/Down move within the same column. Returns the next node id, or null.
 */
export function neighbor(
  graph: Pick<EvidenceGraph, "nodes" | "edges">,
  positions: Map<string, { x: number; y: number }>,
  from: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  visible: Set<string>,
): string | null {
  const here = positions.get(from);
  if (!here) return null;
  const byY = (ids: string[]) =>
    ids
      .filter((id) => visible.has(id) && positions.has(id))
      .sort(
        (a, b) =>
          Math.abs(positions.get(a)!.y - here.y) -
            Math.abs(positions.get(b)!.y - here.y) || a.localeCompare(b),
      );
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const ids = graph.edges.flatMap((e) =>
      key === "ArrowRight"
        ? e.source === from
          ? [e.target]
          : []
        : e.target === from
          ? [e.source]
          : [],
    );
    // Prefer neighbors in the column on that side; fall back to any linked node.
    const side = ids.filter((id) =>
      key === "ArrowRight"
        ? (positions.get(id)?.x ?? 0) > here.x
        : (positions.get(id)?.x ?? 0) < here.x,
    );
    return byY(side.length ? side : ids)[0] ?? null;
  }
  const type = graph.nodes.find((n) => n.id === from)?.type;
  const column = graph.nodes
    .filter((n) => n.type === type && visible.has(n.id) && positions.has(n.id))
    .map((n) => n.id)
    .sort(
      (a, b) => positions.get(a)!.y - positions.get(b)!.y || a.localeCompare(b),
    );
  const i = column.indexOf(from);
  const j = key === "ArrowDown" ? i + 1 : i - 1;
  return column[j] ?? null;
}
