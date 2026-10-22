/**
 * Evidence graph projection (UI_UX_SPEC §4.4 graph tab, PRD §6.4). Pure and deterministic:
 * the API serves it, the browser renders it, and the List view is built from the same output
 * (EG-A4). Every node and edge carries a provenance class; nothing here invents data — a node
 * exists only for a stored entity, hypothesis, claim, or evidence record.
 */
export const GRAPH_VERSION = "graph-1.0.0";

export type GraphProvenance =
  | "QLOO_SOURCED"
  | "APP_DERIVED"
  | "MODEL_INTERPRETATION"
  | "CREATIVE_SPECULATION"
  | "USER_PROVIDED"
  | "DEVELOPMENT_FIXTURE";

export type GraphNodeType = "entity" | "hypothesis" | "claim" | "evidence";

export type GraphEdgeKind =
  | "THREAD" // seed → discovered entity (Qloo recommend)
  | "ELEMENT_OF" // entity → hypothesis (the AI wove it in)
  | "HAS_CLAIM" // hypothesis → claim (AI-proposed testable statement)
  | "TESTED_BY" // claim → evidence (deterministic evaluator)
  | "CITES" // evidence → entity named in the claim's typed parameters
  | "REVISION_OF"; // hypothesis → the hypothesis it revised

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  provenance: GraphProvenance;
  /** Tool invocation behind the node (entities and evidence): the Trace target. */
  invocationId: string | null;
  data: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  provenance: GraphProvenance;
  label: string;
}

export interface EvidenceGraph {
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The subset of the experiment read model the projection needs. */
export interface GraphSource {
  seeds: { entityId: string; role: string }[];
  entities: {
    id: string;
    kind: string;
    name: string;
    domain: string | null;
    provenanceClass: string;
    sourceToolInvocationId: string | null;
  }[];
  relations: {
    id: string;
    kind: string;
    fromEntityId: string;
    toEntityId: string;
    provenanceClass: string;
  }[];
  hypotheses: {
    id: string;
    title: string;
    status: string;
    retired: boolean;
    revisionOfId: string | null;
    iteration: number;
    compositeScore: number | null;
    elements: { entityId: string; role: string }[];
    claims: {
      id: string;
      ordinal: number;
      statement: string;
      testKind: string;
      status: string;
      currentStance: string | null;
      testParams: unknown;
    }[];
    evidence: {
      id: string;
      claimId: string;
      stance: string;
      evaluatorId: string;
      provenanceClass: string;
      toolInvocationId: string | null;
      quality: string;
    }[];
  }[];
}

export interface GraphOptions {
  /** Include discovery threads (seed → result) and entities only reached through them. */
  includeThreads?: boolean;
  /** Include retired and superseded hypotheses (kept visible; HL-A5). */
  includeRetired?: boolean;
}

const prov = (p: string): GraphProvenance =>
  (
    [
      "QLOO_SOURCED",
      "APP_DERIVED",
      "MODEL_INTERPRETATION",
      "CREATIVE_SPECULATION",
      "USER_PROVIDED",
      "DEVELOPMENT_FIXTURE",
    ] as const
  ).includes(p as GraphProvenance)
    ? (p as GraphProvenance)
    : "APP_DERIVED";

/** Entity IDs named in a claim's typed parameters (never free text). */
export function claimEntityIds(testParams: unknown): string[] {
  const params = (testParams ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of [
    "signalEntityIds",
    "targetEntityId",
    "tagEntityIds",
    "optionEntityIds",
    "compareEntityIds",
  ]) {
    const v = params[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v))
      for (const id of v) if (typeof id === "string") out.push(id);
  }
  return [...new Set(out)];
}

export function buildEvidenceGraph(
  source: GraphSource,
  options: GraphOptions = {},
): EvidenceGraph {
  const entities = new Map(source.entities.map((e) => [e.id, e]));
  const seedIds = new Set(
    source.seeds.filter((s) => s.role === "seed").map((s) => s.entityId),
  );
  const locationIds = new Set(
    source.seeds.filter((s) => s.role === "location").map((s) => s.entityId),
  );
  const hyps = source.hypotheses.filter(
    (h) => options.includeRetired || !h.retired,
  );
  const hypIds = new Set(hyps.map((h) => h.id));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEntity = (id: string) => {
    if (nodes.has(id)) return true;
    const e = entities.get(id);
    if (!e) return false;
    nodes.set(id, {
      id,
      type: "entity",
      label: e.name,
      provenance: prov(e.provenanceClass),
      invocationId: e.sourceToolInvocationId,
      data: {
        kind: e.kind,
        domain: e.domain,
        seed: seedIds.has(id),
        location: locationIds.has(id),
      },
    });
    return true;
  };
  const addEdge = (edge: Omit<GraphEdge, "id">) => {
    const id = `${edge.kind}:${edge.source}->${edge.target}`;
    if (!edges.has(id) && nodes.has(edge.source) && nodes.has(edge.target))
      edges.set(id, { id, ...edge });
  };

  for (const id of [...seedIds, ...locationIds]) addEntity(id);

  for (const h of hyps) {
    nodes.set(h.id, {
      id: h.id,
      type: "hypothesis",
      label: h.title,
      provenance: "CREATIVE_SPECULATION",
      invocationId: null,
      data: {
        status: h.status,
        retired: h.retired,
        iteration: h.iteration,
        composite: h.compositeScore,
      },
    });
    for (const el of h.elements) addEntity(el.entityId);
    for (const c of h.claims) {
      nodes.set(c.id, {
        id: c.id,
        type: "claim",
        label: c.statement,
        provenance: "MODEL_INTERPRETATION",
        invocationId: null,
        data: {
          ordinal: c.ordinal,
          testKind: c.testKind,
          status: c.status,
          stance: c.currentStance,
          hypothesisId: h.id,
        },
      });
      for (const id of claimEntityIds(c.testParams)) addEntity(id);
    }
    for (const e of h.evidence) {
      if (!nodes.has(e.claimId)) continue;
      nodes.set(e.id, {
        id: e.id,
        type: "evidence",
        label: e.stance,
        provenance: prov(e.provenanceClass),
        invocationId: e.toolInvocationId,
        data: {
          stance: e.stance,
          evaluatorId: e.evaluatorId,
          quality: e.quality,
          claimId: e.claimId,
          hypothesisId: h.id,
        },
      });
    }
  }

  if (options.includeThreads)
    for (const r of source.relations)
      if (r.kind === "THREAD" && seedIds.has(r.fromEntityId))
        addEntity(r.toEntityId);

  for (const h of hyps) {
    for (const el of h.elements)
      addEdge({
        source: el.entityId,
        target: h.id,
        kind: "ELEMENT_OF",
        provenance: "CREATIVE_SPECULATION",
        label: "woven into",
      });
    if (h.revisionOfId && hypIds.has(h.revisionOfId))
      addEdge({
        source: h.revisionOfId,
        target: h.id,
        kind: "REVISION_OF",
        provenance: "MODEL_INTERPRETATION",
        label: "revised as",
      });
    for (const c of h.claims) {
      addEdge({
        source: h.id,
        target: c.id,
        kind: "HAS_CLAIM",
        provenance: "MODEL_INTERPRETATION",
        label: "claims",
      });
      const latest = [...h.evidence].reverse().find((e) => e.claimId === c.id);
      for (const e of h.evidence.filter((x) => x.claimId === c.id)) {
        addEdge({
          source: c.id,
          target: e.id,
          kind: "TESTED_BY",
          provenance: "APP_DERIVED",
          label: "tested by",
        });
        // Only the latest record's citations: earlier records were superseded.
        if (e === latest)
          for (const id of claimEntityIds(c.testParams))
            addEdge({
              source: e.id,
              target: id,
              kind: "CITES",
              provenance: prov(e.provenanceClass),
              label: "cites",
            });
      }
    }
  }
  for (const r of source.relations)
    if (r.kind === "THREAD")
      addEdge({
        source: r.fromEntityId,
        target: r.toEntityId,
        kind: "THREAD",
        provenance: prov(r.provenanceClass),
        label: "thread",
      });

  const order: Record<GraphNodeType, number> = {
    entity: 0,
    hypothesis: 1,
    claim: 2,
    evidence: 3,
  };
  return {
    version: GRAPH_VERSION,
    nodes: [...nodes.values()].sort(
      (a, b) => order[a.type] - order[b.type] || a.id.localeCompare(b.id),
    ),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
