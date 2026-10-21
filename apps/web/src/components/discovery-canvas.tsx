"use client";

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
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  laneItems,
  type DiscoveryGraph,
  type GraphEntity,
} from "@/lib/discovery-graph";
import { cn } from "@/lib/utils";
import { DOMAIN_LABEL } from "./provenance";

const LANE_WIDTH = 230;
const ROW = 62;

type EntityNodeData = {
  item: GraphEntity;
  selected: boolean;
  dimmed: boolean;
  inPool: boolean;
};
type LaneNodeData = { label: string; count: number };

const EntityNode = memo(function EntityNode({
  data,
}: NodeProps<Node<EntityNodeData>>) {
  const { item, inPool, dimmed } = data;
  return (
    <div
      className={cn(
        "w-[200px] rounded-lg px-3 py-2 text-left text-xs shadow-sm transition-opacity",
        `prov-${item.entity.provenanceClass}`,
        item.isSeed &&
          "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        inPool && "outline outline-2 outline-offset-2 outline-weft",
        dimmed && "opacity-35",
      )}
      title={item.entity.name}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1.5 !border-0 !bg-muted-foreground"
      />
      <p className="truncate text-[13px] font-semibold">{item.entity.name}</p>
      <p className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{item.isSeed ? "Seed" : `#${item.bestPosition + 1}`}</span>
        <span>
          {item.seeds.length > 1
            ? `in ${item.seeds.length} threads`
            : item.entity.provenanceClass === "DEVELOPMENT_FIXTURE"
              ? "fixture"
              : "Qloo data"}
        </span>
      </p>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-1.5 !border-0 !bg-muted-foreground"
      />
    </div>
  );
});

const LaneNode = memo(function LaneNode({
  data,
}: NodeProps<Node<LaneNodeData>>) {
  return (
    <div className="w-[200px] border-b-2 border-warp pb-1 text-xs font-semibold uppercase tracking-[0.14em] text-warp">
      {data.label}{" "}
      <span className="font-mono font-normal text-muted-foreground">
        ({data.count})
      </span>
    </div>
  );
});

const nodeTypes = { entity: EntityNode, lane: LaneNode };

export function DiscoveryCanvas({
  graph,
  selectedId,
  onSelect,
  poolPairs,
  visibleLanes,
  bridgesOnly,
  showAll,
}: {
  graph: DiscoveryGraph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  poolPairs: [string, string][];
  visibleLanes: Set<string>;
  bridgesOnly: boolean;
  showAll: boolean;
}) {
  const [announce, setAnnounce] = useState("");
  const container = useRef<HTMLDivElement>(null);
  // Controlled nodes are rebuilt whenever the graph or pool changes; React Flow resets a node's
  // measurement when its object changes and hides it until re-measured, which can stall.
  // Feeding the measured sizes back keeps rebuilt nodes visible.
  const [measured, setMeasured] = useState<
    ReadonlyMap<string, { width: number; height: number }>
  >(new Map());
  const onNodesChange = useCallback((changes: NodeChange[]) => {
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
  // Keyboard: Enter or Space on a focused node opens the inspector (UI_UX_SPEC §8).
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        ".react-flow__node-entity",
      );
      const id = target?.dataset.id;
      const item = id ? graph.entities.get(id) : undefined;
      if (!id || !item) return;
      event.preventDefault();
      onSelect(id);
      setAnnounce(`Selected ${item.entity.name}`);
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, [graph, onSelect]);
  const inPool = useMemo(() => new Set(poolPairs.flat()), [poolPairs]);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const lanes = graph.lanes.filter((l) => visibleLanes.has(l));
    lanes.forEach((lane, li) => {
      const items = laneItems(graph, lane)
        .filter(
          (n) =>
            !bridgesOnly ||
            n.isSeed ||
            n.seeds.length > 1 ||
            inPool.has(n.entity.id),
        )
        // Lanes show the strongest results by default; bridges and pool members always stay.
        .filter(
          (n, i) =>
            showAll ||
            i < 10 ||
            n.isSeed ||
            n.seeds.length > 1 ||
            inPool.has(n.entity.id),
        );
      nodes.push({
        id: `lane-${lane}`,
        type: "lane",
        position: { x: li * LANE_WIDTH, y: 0 },
        data: { label: DOMAIN_LABEL[lane] ?? lane, count: items.length },
        selectable: false,
        focusable: false,
        draggable: false,
      });
      items.forEach((item, i) => {
        nodes.push({
          id: item.entity.id,
          type: "entity",
          position: {
            x: li * LANE_WIDTH,
            y: 44 + (item.isSeed ? 0 : 30) + i * ROW,
          },
          data: {
            item,
            selected: item.entity.id === selectedId,
            dimmed:
              !!selectedId &&
              selectedId !== item.entity.id &&
              !item.seeds.includes(selectedId) &&
              !graph.entities.get(selectedId)?.seeds.includes(item.entity.id),
            inPool: inPool.has(item.entity.id),
          },
          selected: item.entity.id === selectedId,
          draggable: false,
          ariaLabel: `${item.entity.name}, ${DOMAIN_LABEL[item.lane] ?? item.lane}${item.isSeed ? ", seed" : `, rank ${item.bestPosition + 1}`}${item.seeds.length > 1 ? `, in ${item.seeds.length} threads` : ""}`,
        });
      });
    });
    const shown = new Set(nodes.map((n) => n.id));
    for (const r of graph.threads)
      if (shown.has(r.fromEntityId) && shown.has(r.toEntityId))
        edges.push({
          id: r.id,
          source: r.fromEntityId,
          target: r.toEntityId,
          type: "smoothstep",
          style: {
            stroke: "var(--tl-warp)",
            strokeOpacity:
              selectedId &&
              selectedId !== r.fromEntityId &&
              selectedId !== r.toEntityId
                ? 0.08
                : 0.35,
            strokeWidth: 1.2,
          },
        });
    for (const [a, b] of poolPairs)
      if (shown.has(a) && shown.has(b))
        edges.push({
          id: `pool-${a}-${b}`,
          source: a,
          target: b,
          type: "straight",
          animated: false,
          style: {
            stroke: "var(--tl-weft)",
            strokeWidth: 2.5,
            strokeDasharray: "6 4",
          },
          ariaLabel: "Selected collision",
        });
    return {
      nodes: nodes.map((n) => {
        const size = measured.get(n.id);
        return size ? { ...n, measured: size } : n;
      }),
      edges,
    };
  }, [
    measured,
    graph,
    visibleLanes,
    bridgesOnly,
    showAll,
    inPool,
    poolPairs,
    selectedId,
  ]);

  return (
    <div
      className="relative h-[620px] overflow-hidden rounded-xl border border-border bg-background"
      data-testid="discovery-canvas"
      ref={container}
    >
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1, minZoom: 0.6 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        onNodeClick={(_, node) => {
          if (node.type !== "entity") return;
          onSelect(node.id);
          setAnnounce(
            `Selected ${(node.data as EntityNodeData).item.entity.name}`,
          );
        }}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={LANE_WIDTH}
          color="var(--tl-line)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
