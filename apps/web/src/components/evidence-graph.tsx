"use client";

import type {
  EvidenceGraph,
  GraphEdge,
  GraphNode,
  GraphNodeType,
} from "@tessaloom/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { LayoutGrid, List, Search, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { layoutGraph, neighbor } from "@/lib/graph-layout";
import type { Provenance } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  DOMAIN_LABEL,
  PROVENANCE_LABEL,
  ProvenanceChip,
  StatusPill,
} from "./provenance";
import { TraceDialog } from "./trace-dialog";
import { Button, Card, EmptyState, Skeleton } from "./ui";

type GraphView = EvidenceGraph & {
  layout: Record<string, { x: number; y: number }> | null;
};

export const TYPE_LABEL: Record<GraphNodeType, string> = {
  entity: "Cultural entity",
  hypothesis: "Hypothesis",
  claim: "Claim",
  evidence: "Evidence",
};
const TYPES: GraphNodeType[] = ["entity", "hypothesis", "claim", "evidence"];
const EDGE_LABEL: Record<GraphEdge["kind"], string> = {
  THREAD: "discovery thread",
  ELEMENT_OF: "woven into",
  HAS_CLAIM: "claims",
  TESTED_BY: "tested by",
  CITES: "cites",
  REVISION_OF: "revised as",
};

/** A sentence a screen reader can announce for a node. */
export function describeNode(n: GraphNode): string {
  const prov = PROVENANCE_LABEL[n.provenance as Provenance];
  switch (n.type) {
    case "entity":
      return `${TYPE_LABEL.entity}: ${n.label}, ${DOMAIN_LABEL[String(n.data.domain)] ?? n.data.domain ?? "unknown type"}${n.data.seed ? ", seed" : ""}. ${prov}`;
    case "hypothesis":
      return `${TYPE_LABEL.hypothesis}: ${n.label}, ${String(n.data.status).replace(/_/g, " ").toLowerCase()}${n.data.retired ? ", retired" : ""}. ${prov}`;
    case "claim":
      return `${TYPE_LABEL.claim} ${Number(n.data.ordinal) + 1}: ${n.label}. ${n.data.stance ? `Stance ${String(n.data.stance).toLowerCase()}` : String(n.data.status).toLowerCase()}. ${prov}`;
    case "evidence":
      return `${TYPE_LABEL.evidence}: ${String(n.data.stance).toLowerCase()} by rule ${n.data.evaluatorId}. ${prov}`;
  }
}

type NodeData = { node: GraphNode; selected: boolean; dimmed: boolean };

const STANCE_SYMBOL: Record<string, string> = {
  SUPPORTS: "✔",
  CONTRADICTS: "✖",
  NEUTRAL: "–",
  INSUFFICIENT: "◌",
};

/** Node shape encodes the type; the provenance class (border style + text) encodes origin. */
const GraphNodeCard = memo(function GraphNodeCard({
  data,
}: NodeProps<Node<NodeData>>) {
  const { node: n, selected, dimmed } = data;
  const prov = PROVENANCE_LABEL[n.provenance as Provenance];
  return (
    <div
      data-node-type={n.type}
      data-provenance={n.provenance}
      className={cn(
        "relative bg-card text-left text-xs shadow-sm transition-opacity",
        `prov-${n.provenance}`,
        n.type === "entity" && "w-[230px] rounded-lg px-3 py-2",
        n.type === "hypothesis" && "w-[280px] rounded-2xl px-3.5 py-2.5",
        n.type === "claim" && "w-[300px] rounded-full px-4 py-2",
        n.type === "evidence" && "w-[190px] rounded-sm px-2.5 py-1.5",
        selected &&
          "outline outline-3 outline-offset-2 outline-[var(--tl-warp)]",
        dimmed && "opacity-30",
        Boolean(n.data.retired) && "opacity-60",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1.5 !border-0 !bg-muted-foreground"
      />
      <p className="flex items-center justify-between gap-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>
          {TYPE_LABEL[n.type]}
          {n.type === "entity" && n.data.seed ? " · seed" : ""}
        </span>
        <span className="truncate normal-case tracking-normal">{prov}</span>
      </p>
      {n.type === "evidence" ? (
        <p className="mt-0.5 font-semibold">
          <span aria-hidden>{STANCE_SYMBOL[String(n.data.stance)] ?? "•"}</span>{" "}
          {String(n.data.stance).toLowerCase()}
          <span className="ml-1 font-mono text-[9px] font-normal text-muted-foreground">
            {String(n.data.evaluatorId).split("@")[0]?.toLowerCase()}
          </span>
        </p>
      ) : (
        <p
          className={cn(
            "mt-0.5 line-clamp-2 font-medium",
            n.type === "hypothesis" && "font-serif text-[15px] leading-snug",
          )}
        >
          {n.type === "claim" ? `${Number(n.data.ordinal) + 1}. ` : ""}
          {n.label}
        </p>
      )}
      {n.type === "hypothesis" ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {String(n.data.status).replace(/_/g, " ").toLowerCase()}
          {n.data.composite !== null
            ? ` · composite ${Math.round(Number(n.data.composite))}`
            : ""}
          {n.data.retired ? " · retired" : ""}
        </p>
      ) : null}
      {n.type === "entity" ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {DOMAIN_LABEL[String(n.data.domain)] ??
            n.data.domain ??
            "Unknown type"}
        </p>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-1.5 !border-0 !bg-muted-foreground"
      />
    </div>
  );
});

const nodeTypes = { graph: GraphNodeCard };

const EDGE_STYLE: Record<string, React.CSSProperties> = {
  QLOO_SOURCED: { stroke: "var(--tl-warp)", strokeWidth: 1.6 },
  DEVELOPMENT_FIXTURE: {
    stroke: "var(--tl-rust)",
    strokeWidth: 1.6,
    strokeDasharray: "2 3",
  },
  APP_DERIVED: { stroke: "var(--tl-ink)", strokeWidth: 1.2 },
  MODEL_INTERPRETATION: {
    stroke: "var(--tl-weft)",
    strokeWidth: 1.4,
    strokeDasharray: "6 4",
  },
  CREATIVE_SPECULATION: {
    stroke: "var(--tl-saffron)",
    strokeWidth: 1.6,
    strokeDasharray: "1 4",
    strokeLinecap: "round",
  },
};

function Inspector({
  node,
  graph,
  onSelect,
  onClose,
  onTrace,
  onOpenEvidence,
}: {
  node: GraphNode;
  graph: EvidenceGraph;
  onSelect: (id: string) => void;
  onClose: () => void;
  onTrace: (node: GraphNode) => void;
  onOpenEvidence: (hypothesisId: string) => void;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const links = graph.edges.filter(
    (e) => e.source === node.id || e.target === node.id,
  );
  const hypothesisId =
    node.type === "hypothesis"
      ? node.id
      : typeof node.data.hypothesisId === "string"
        ? node.data.hypothesisId
        : null;
  return (
    <Card className="p-4" aria-label={`Inspector: ${node.label}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {TYPE_LABEL[node.type]}
          </p>
          <p
            className={cn(
              "mt-0.5 leading-snug",
              node.type === "hypothesis" ? "font-serif text-xl" : "font-medium",
            )}
          >
            {node.type === "evidence"
              ? `${String(node.data.stance).toLowerCase()} (${node.data.evaluatorId})`
              : node.label}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ProvenanceChip provenance={node.provenance as Provenance} />
            {node.type === "hypothesis" ? (
              <StatusPill status={String(node.data.status)} />
            ) : null}
            {node.type === "claim" && node.data.stance ? (
              <StatusPill status={String(node.data.stance)} />
            ) : null}
            {node.type === "evidence" ? (
              <StatusPill status={String(node.data.stance)} />
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
        {Object.entries(node.data)
          .filter(
            ([k, v]) =>
              v !== null && !["hypothesisId", "claimId", "ordinal"].includes(k),
          )
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">
                {k.replace(/([A-Z])/g, " $1").toLowerCase()}
              </dt>
              <dd className="font-mono">{String(v)}</dd>
            </div>
          ))}
      </dl>
      {node.provenance === "MODEL_INTERPRETATION" ||
      node.provenance === "CREATIVE_SPECULATION" ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Written by the AI. It is tested against Qloo data, never treated as
          Qloo data.
        </p>
      ) : null}
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connections ({links.length})
      </p>
      <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto text-xs">
        {links.map((e) => {
          const other = byId.get(e.source === node.id ? e.target : e.source);
          if (!other) return null;
          return (
            <li key={e.id}>
              <button
                type="button"
                className="w-full rounded px-1.5 py-1 text-left hover:bg-surface-2"
                onClick={() => onSelect(other.id)}
              >
                <span className="text-muted-foreground">
                  {e.source === node.id ? "→" : "←"} {EDGE_LABEL[e.kind]}:
                </span>{" "}
                {other.type === "evidence"
                  ? `${String(other.data.stance).toLowerCase()} evidence`
                  : other.label}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {node.invocationId ? (
          <Button variant="secondary" size="sm" onClick={() => onTrace(node)}>
            <Search aria-hidden className="size-3.5" /> Trace
          </Button>
        ) : null}
        {hypothesisId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenEvidence(hypothesisId)}
          >
            Open evidence drawer
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Interactive evidence graph (UI_UX_SPEC §4.4 graph tab, §8). Canvas and List views share the
 * same projection, so the List view lists every node and edge the canvas shows (EG-A4).
 */
export function EvidenceGraphView({
  experimentId,
  version,
  onOpenEvidence,
}: {
  experimentId: string;
  /** Changes when the experiment data changes (refetch trigger). */
  version: string;
  onOpenEvidence: (hypothesisId: string) => void;
}) {
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"canvas" | "list">("canvas");
  const [threads, setThreads] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(new Set());
  const [hiddenProv, setHiddenProv] = useState<Set<string>>(new Set());
  // Citation links run from evidence back to entities across the whole canvas; they are off
  // by default and always shown for the selected node.
  const [hiddenEdges, setHiddenEdges] = useState<Set<GraphEdge["kind"]>>(
    new Set(["CITES"]),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<GraphNode | null>(null);
  const [announce, setAnnounce] = useState("");
  const [dragged, setDragged] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [measured, setMeasured] = useState<
    ReadonlyMap<string, { width: number; height: number }>
  >(new Map());
  const container = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GraphView>(
        `/api/v1/experiments/${experimentId}/graph?include=retired${threads ? ",threads" : ""}`,
      )
      .then((g) => {
        if (!cancelled) setGraph(g);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [experimentId, version, threads]);

  const positions = useMemo(
    () =>
      graph
        ? layoutGraph(graph, { ...(graph.layout ?? {}), ...dragged })
        : new Map<string, { x: number; y: number }>(),
    [graph, dragged],
  );
  const visible = useMemo(
    () =>
      new Set(
        (graph?.nodes ?? [])
          .filter(
            (n) => !hiddenTypes.has(n.type) && !hiddenProv.has(n.provenance),
          )
          .map((n) => n.id),
      ),
    [graph, hiddenTypes, hiddenProv],
  );
  const visibleEdges = useMemo(
    () =>
      (graph?.edges ?? []).filter(
        (e) =>
          visible.has(e.source) &&
          visible.has(e.target) &&
          (!hiddenEdges.has(e.kind) ||
            e.source === selected ||
            e.target === selected),
      ),
    [graph, visible, hiddenEdges, selected],
  );
  const neighborhood = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected]);
    for (const e of visibleEdges)
      if (e.source === selected) ids.add(e.target);
      else if (e.target === selected) ids.add(e.source);
    return ids;
  }, [selected, visibleEdges]);

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      const node = id ? graph?.nodes.find((n) => n.id === id) : null;
      if (!node) return;
      setAnnounce(`Selected. ${describeNode(node)}`);
      // The inspector narrows the canvas: keep the selected node in view.
      const p = positions.get(node.id);
      const flow = flowRef.current;
      if (p && flow) {
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        requestAnimationFrame(
          () =>
            void flow.setCenter(p.x + 130, p.y + 30, {
              zoom: Math.max(flow.getZoom(), 0.72),
              duration: reduce ? 0 : 250,
            }),
        );
      }
    },
    [graph, positions],
  );

  // Keyboard (UI_UX_SPEC §8): arrows move between connected nodes, Enter/Space selects.
  useEffect(() => {
    const element = container.current;
    if (!element || !graph) return;
    const onKey = (event: KeyboardEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        ".react-flow__node",
      );
      const id = target?.dataset.id;
      if (!id) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(id);
        return;
      }
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const next = neighbor(
        { nodes: graph.nodes, edges: visibleEdges },
        positions,
        id,
        event.key as "ArrowLeft",
        visible,
      );
      if (!next) {
        setAnnounce("No connected node in that direction.");
        return;
      }
      element
        .querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(next)}"]`,
        )
        ?.focus();
      const node = graph.nodes.find((n) => n.id === next);
      if (node) setAnnounce(describeNode(node));
    };
    element.addEventListener("keydown", onKey, true);
    return () => element.removeEventListener("keydown", onKey, true);
  }, [graph, visibleEdges, positions, visible, select]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moves: Record<string, { x: number; y: number }> = {};
    for (const c of changes)
      if (c.type === "position" && c.position) moves[c.id] = c.position;
    if (Object.keys(moves).length) setDragged((d) => ({ ...d, ...moves }));
    setMeasured((prev) => {
      let next: Map<string, { width: number; height: number }> | null = null;
      for (const c of changes) {
        if (c.type !== "dimensions" || !c.dimensions) continue;
        const old = prev.get(c.id);
        if (
          old?.width === c.dimensions.width &&
          old?.height === c.dimensions.height
        )
          continue;
        next ??= new Map(prev);
        next.set(c.id, c.dimensions);
      }
      return next ?? prev;
    });
  }, []);

  const saveLayout = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api
        .put(`/api/v1/experiments/${experimentId}/graph-layout`, {
          positions: [...positions].map(([nodeId, p]) => ({
            nodeId,
            x: Math.round(p.x),
            y: Math.round(p.y),
          })),
        })
        .catch(() => setAnnounce("The layout could not be saved."));
    }, 600);
  }, [experimentId, positions]);

  const flow = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = graph.nodes
      .filter((n) => visible.has(n.id))
      .map((n) => {
        const size = measured.get(n.id);
        return {
          id: n.id,
          type: "graph",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          data: {
            node: n,
            selected: n.id === selected,
            dimmed: !!neighborhood && !neighborhood.has(n.id),
          },
          ariaLabel: describeNode(n),
          ...(size ? { measured: size } : {}),
        };
      });
    const edges: Edge[] = visibleEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "default",
      style: {
        ...EDGE_STYLE[e.provenance],
        opacity: neighborhood
          ? neighborhood.has(e.source) && neighborhood.has(e.target)
            ? 1
            : 0.12
          : 0.7,
      },
      ariaLabel: `${EDGE_LABEL[e.kind]} (${PROVENANCE_LABEL[e.provenance as Provenance]})`,
    }));
    return { nodes, edges };
  }, [
    graph,
    visible,
    visibleEdges,
    positions,
    selected,
    neighborhood,
    measured,
  ]);

  if (error)
    return (
      <p role="alert" className="text-sm text-rust">
        {error}
      </p>
    );
  if (!graph) return <Skeleton className="h-[640px]" />;
  if (!graph.nodes.length) return <EmptyState title="Nothing to graph yet." />;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const selectedNode = selected ? byId.get(selected) : undefined;
  const provenances = [...new Set(graph.nodes.map((n) => n.provenance))];
  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="space-y-3" data-testid="evidence-graph">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Node types</legend>
          {TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!hiddenTypes.has(t)}
                onChange={() => setHiddenTypes((s) => toggle(s, t))}
              />
              {TYPE_LABEL[t]}
              <span className="font-mono text-xs text-muted-foreground">
                {graph.nodes.filter((n) => n.type === t).length}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Provenance</legend>
          {provenances.map((p) => (
            <label key={p} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!hiddenProv.has(p)}
                onChange={() => setHiddenProv((s) => toggle(s, p))}
              />
              {PROVENANCE_LABEL[p as Provenance]}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Connections</legend>
          {(["CITES", "REVISION_OF"] as const)
            .filter((k) => graph.edges.some((e) => e.kind === k))
            .map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!hiddenEdges.has(k)}
                  onChange={() => setHiddenEdges((s) => toggle(s, k))}
                />
                {k === "CITES" ? "Citation links" : "Revision links"}
              </label>
            ))}
        </fieldset>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={threads}
            onChange={(e) => setThreads(e.target.checked)}
          />
          Discovery threads
        </label>
        <div
          className="ml-auto flex rounded-md border border-border p-0.5"
          role="group"
          aria-label="Graph view"
        >
          <Button
            variant={mode === "canvas" ? "primary" : "ghost"}
            size="sm"
            aria-pressed={mode === "canvas"}
            onClick={() => setMode("canvas")}
          >
            <LayoutGrid aria-hidden className="size-4" /> Canvas
          </Button>
          <Button
            variant={mode === "list" ? "primary" : "ghost"}
            size="sm"
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List aria-hidden className="size-4" /> List
          </Button>
        </div>
      </div>
      <p className="sr-only" aria-live="polite" data-testid="graph-announcer">
        {announce}
      </p>
      <div
        className={cn(
          "grid gap-4",
          selectedNode && "xl:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        {mode === "canvas" ? (
          <div
            ref={container}
            className="relative h-[640px] overflow-hidden rounded-xl border border-border bg-background"
            data-testid="graph-canvas"
          >
            <p className="pointer-events-none absolute left-3 top-2 z-10 text-[11px] text-muted-foreground">
              Tab to a node · arrows follow its connections · Enter inspects ·
              drag to rearrange (saved)
            </p>
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onInit={(instance) => {
                flowRef.current = instance;
              }}
              onNodeDragStop={saveLayout}
              onNodeClick={(_, node) => select(node.id)}
              onPaneClick={() => select(null)}
              defaultViewport={{
                x: 24,
                y:
                  40 -
                  Math.min(0, ...[...positions.values()].map((p) => p.y)) *
                    0.72,
                zoom: 0.72,
              }}
              minZoom={0.15}
              nodesConnectable={false}
              nodesFocusable
              edgesFocusable={false}
              onlyRenderVisibleElements
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                color="var(--tl-line)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        ) : (
          <div className="space-y-6" data-testid="graph-list">
            <table className="w-full text-left text-sm">
              <caption className="mb-1 text-left font-semibold">
                Nodes ({[...visible].length})
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Label</th>
                  <th className="py-1 font-medium">Provenance</th>
                  <th className="py-1 font-medium">Status / stance</th>
                </tr>
              </thead>
              <tbody>
                {graph.nodes
                  .filter((n) => visible.has(n.id))
                  .map((n) => (
                    <tr
                      key={n.id}
                      className="border-t border-border align-top"
                      data-testid="graph-list-node"
                    >
                      <td className="py-1 pr-2 text-xs">
                        {TYPE_LABEL[n.type]}
                      </td>
                      <td className="py-1 pr-2">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => select(n.id)}
                        >
                          {n.type === "evidence"
                            ? `${String(n.data.stance).toLowerCase()} (${n.data.evaluatorId})`
                            : n.label}
                        </button>
                      </td>
                      <td className="py-1 pr-2 text-xs">
                        {PROVENANCE_LABEL[n.provenance as Provenance]}
                      </td>
                      <td className="py-1 text-xs">
                        {String(
                          n.data.stance ?? n.data.status ?? n.data.domain ?? "",
                        )
                          .replace(/_/g, " ")
                          .toLowerCase()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <table className="w-full text-left text-sm">
              <caption className="mb-1 text-left font-semibold">
                Connections ({visibleEdges.length})
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">From</th>
                  <th className="py-1 font-medium">Relation</th>
                  <th className="py-1 font-medium">To</th>
                  <th className="py-1 font-medium">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {visibleEdges.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-border align-top"
                    data-testid="graph-list-edge"
                  >
                    <td className="py-1 pr-2">{byId.get(e.source)?.label}</td>
                    <td className="py-1 pr-2 text-xs">{EDGE_LABEL[e.kind]}</td>
                    <td className="py-1 pr-2">
                      {byId.get(e.target)?.type === "evidence"
                        ? `${String(byId.get(e.target)?.data.stance).toLowerCase()} evidence`
                        : byId.get(e.target)?.label}
                    </td>
                    <td className="py-1 text-xs">
                      {PROVENANCE_LABEL[e.provenance as Provenance]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedNode ? (
          <Inspector
            node={selectedNode}
            graph={graph}
            onSelect={select}
            onClose={() => select(null)}
            onTrace={setTrace}
            onOpenEvidence={onOpenEvidence}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Shape shows the kind of node; border style and the label show where it
        came from. Qloo numbers are aggregate audience-affinity signals, not
        measures of creative fit.
      </p>
      {trace ? (
        <TraceDialog
          {...(trace.type === "evidence"
            ? { evidenceId: trace.id }
            : { invocationId: trace.invocationId! })}
          onClose={() => setTrace(null)}
        />
      ) : null}
    </div>
  );
}
