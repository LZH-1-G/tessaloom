"use client";

import { CircleAlert, LayoutGrid, List, MapPin, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  buildDiscoveryGraph,
  laneItems,
  type GraphEntity,
} from "@/lib/discovery-graph";
import { describeRunStop, POOL_TOO_SMALL_TIPS } from "@/lib/run-outcome";
import type { EntityView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EntityConfirmation } from "./entity-confirmation";
import { PoolPanel, poolRows, poolSelection } from "./pool-panel";
import { useProject } from "./project-context";
import {
  DOMAIN_LABEL,
  DataOriginBadge,
  DomainBadge,
  ProvenanceChip,
} from "./provenance";
import { TraceDialog } from "./trace-dialog";
import { Button, Card, EmptyState, SectionTitle, Skeleton } from "./ui";

const DiscoveryCanvas = dynamic(
  () => import("./discovery-canvas").then((m) => m.DiscoveryCanvas),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[620px]" />,
  },
);

export function Inspector({
  item,
  entities,
  onClose,
  onTrace,
}: {
  item: GraphEntity;
  entities: Map<string, GraphEntity>;
  onClose: () => void;
  onTrace: (invocationId: string) => void;
}) {
  const e = item.entity;
  return (
    <Card className="p-4" aria-label={`Inspector: ${e.name}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-serif text-xl leading-snug">{e.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <DomainBadge domain={e.domain} />
            <ProvenanceChip
              provenance={e.provenanceClass}
              origin={e.dataOrigin}
              retrievedAt={e.retrievedAt}
            />
            {item.isSeed ? (
              <span className="rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold uppercase text-background">
                Seed
              </span>
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
      {e.disambiguation ? (
        <p className="mt-2 text-sm text-muted-foreground">{e.disambiguation}</p>
      ) : null}
      {typeof e.snapshot.description === "string" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {e.snapshot.description}
        </p>
      ) : null}
      {item.facts.length ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Facts
          </p>
          <ul className="mt-1 space-y-1.5 text-sm">
            {item.facts.flatMap((r) =>
              r.facts.map((f, i) => (
                <li
                  key={`${r.id}-${i}`}
                  className="rounded border border-border px-2 py-1.5"
                >
                  <span>{f.statement}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                    {f.jsonPointer} = {JSON.stringify(f.value)}{" "}
                    {f.verifiedAtIngest ? "· verified at ingest" : ""}
                  </span>
                </li>
              )),
            )}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Affinity is an aggregate audience signal, not a measure of creative
            fit.
          </p>
        </div>
      ) : null}
      {item.seeds.length ? (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">In the threads of </span>
          {item.seeds
            .map((s) => entities.get(s)?.entity.name ?? "a seed")
            .join(", ")}
        </p>
      ) : null}
      {item.tags.length ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Tags (Qloo)
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {item.tags.map((t) => (
              <li
                key={t.id}
                className="rounded-full border border-border px-2 py-0.5 text-xs"
              >
                {t.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          No tags fetched for this entity (tag calls are budgeted).
        </p>
      )}
      {e.sourceToolInvocationId ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() => onTrace(e.sourceToolInvocationId!)}
        >
          <Search aria-hidden className="size-4" /> Trace
        </Button>
      ) : null}
    </Card>
  );
}

export function DiscoveryPage() {
  const { projectId, view, run, refresh, loading } = useProject();
  const [chosenMode, setMode] = useState<"canvas" | "list" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const [bridgesOnly, setBridgesOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tensionChoice, setTension] = useState<number | null>(null);
  const graph = useMemo(
    () => (view ? buildDiscoveryGraph(view) : null),
    [view],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () => new Set((graph?.lanes ?? []).filter((l) => !hidden.has(l))),
    [graph, hidden],
  );
  // UI_UX_SPEC §9: narrow screens default to the list view.
  const narrow = useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(max-width: 767px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
  const mode = chosenMode ?? (narrow ? "list" : "canvas");
  const rows = useMemo(() => (view ? poolRows(view) : []), [view]);
  const poolGateOpen = run?.state === "AWAITING_POOL_CONFIRMATION";
  const proposed = run?.pendingConfirmation?.tension;
  const tension =
    tensionChoice ??
    (typeof proposed === "number"
      ? proposed
      : (view?.experiment.definition.variables.collisionTension ?? 0.55));
  const selection = useMemo(
    () => poolSelection(rows, poolGateOpen, tension),
    [rows, poolGateOpen, tension],
  );

  if (loading) return <Skeleton className="h-96" />;
  if (!view || !graph)
    return (
      <EmptyState title="Nothing discovered yet.">
        Interpret and confirm a brief first.
      </EmptyState>
    );

  const interests = view.brief?.content.interests.map((i) => i.text) ?? [];
  const pendingRows =
    run?.state === "AWAITING_ENTITY_CONFIRMATION"
      ? view.resolutions.filter(
          (r) => r.status === "AMBIGUOUS" || r.status === "UNRESOLVED",
        )
      : [];
  const byId = new Map(view.entities.map((e) => [e.id, e]));
  const poolPairs = selection.map(
    (s) => s.key.split("|").slice(0, 2) as [string, string],
  );
  const selectedItem = selected ? graph.entities.get(selected) : undefined;
  // Gate H2b is the task at hand while it is open, so the review sits above the canvas.
  const poolPanel = selection.length ? (
    <PoolPanel
      rows={rows}
      selection={selection}
      gateOpen={poolGateOpen}
      runId={run?.id ?? null}
      tension={tension}
      onTension={setTension}
      onDone={() => {
        setTension(null);
        void refresh();
      }}
    />
  ) : null;
  const discovering =
    run && ["RESOLVING_ENTITIES", "DISCOVERING"].includes(run.state);
  // Live Qloo data can legitimately yield too few bridges; explain it and offer a next step.
  const insufficient =
    run?.state === "FAILED" &&
    ["POOL_TOO_SMALL", "NO_DISCOVERY_DATA"].includes(run.terminalReason ?? "")
      ? describeRunStop(run.terminalReason)
      : null;

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="Step 2" title="Discovery canvas">
        {graph.threads.length ? (
          <div
            className="flex rounded-md border border-border p-0.5"
            role="group"
            aria-label="View"
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
        ) : null}
      </SectionTitle>

      {pendingRows.length && run ? (
        <EntityConfirmation
          runId={run.id}
          rows={pendingRows}
          interests={interests}
          onDone={() => void refresh()}
        />
      ) : null}

      <section aria-labelledby="seeds-heading">
        <h2 id="seeds-heading" className="mb-2 text-sm font-semibold">
          Seeds
        </h2>
        <ul className="flex flex-wrap gap-2">
          {view.resolutions.map((r) => {
            const entity: EntityView | undefined = r.selectedEntityId
              ? byId.get(r.selectedEntityId)
              : undefined;
            return (
              <li
                key={r.id}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
                  r.status === "RESOLVED"
                    ? "border-warp/50 bg-card"
                    : "border-dashed border-border text-muted-foreground",
                )}
              >
                {r.requestedKind === "locality" ? (
                  <MapPin aria-hidden className="size-3.5" />
                ) : null}
                <span className="font-medium">
                  {entity?.name ?? r.inputText}
                </span>
                {entity ? <DomainBadge domain={entity.domain} /> : null}
                <span className="font-mono text-[10px] uppercase">
                  {r.status === "RESOLVED"
                    ? r.method === "EXACT_SINGLE"
                      ? "exact match"
                      : "your choice"
                    : r.status.toLowerCase()}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {poolGateOpen ? poolPanel : null}

      {discovering ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-card p-4 text-sm"
        >
          {run.state === "RESOLVING_ENTITIES"
            ? "Resolving your interests with Qloo…"
            : "Threading your seeds into other worlds…"}
        </p>
      ) : null}

      {insufficient ? (
        <section
          aria-labelledby="insufficient-heading"
          className="rounded-lg border-2 border-saffron bg-saffron-tint p-4 text-sm"
        >
          <h2
            id="insufficient-heading"
            className="flex items-center gap-1.5 font-semibold"
          >
            <CircleAlert aria-hidden className="size-4" />
            {insufficient.title}
          </h2>
          <p className="mt-1">{insufficient.detail}</p>
          {graph.threads.length ? (
            <p className="mt-1 text-muted-foreground">
              This run found {graph.threads.length} thread results across{" "}
              {graph.lanes.length} world{graph.lanes.length === 1 ? "" : "s"};
              they are shown below and stay saved.
            </p>
          ) : null}
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {POOL_TOO_SMALL_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          <Link
            href={`/projects/${projectId}/brief`}
            className="mt-3 inline-block font-medium text-warp underline underline-offset-2"
          >
            Revise the brief and try again
          </Link>
        </section>
      ) : null}

      {graph.threads.length ? (
        <>
          <div
            className="flex flex-wrap items-center gap-3 text-sm"
            role="group"
            aria-label="Filters"
          >
            {graph.lanes.map((lane) => (
              <label key={lane} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={visible.has(lane)}
                  onChange={(e) =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (e.target.checked) n.delete(lane);
                      else n.add(lane);
                      return n;
                    })
                  }
                />
                {DOMAIN_LABEL[lane] ?? lane}
              </label>
            ))}
            <label className="ml-auto flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={bridgesOnly}
                onChange={(e) => setBridgesOnly(e.target.checked)}
              />
              Show only bridges
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              Show all results
            </label>
          </div>
          <div
            className={cn(
              "grid gap-4",
              selectedItem && "xl:grid-cols-[minmax(0,1fr)_320px]",
            )}
          >
            {mode === "canvas" ? (
              <DiscoveryCanvas
                graph={graph}
                selectedId={selected}
                onSelect={setSelected}
                poolPairs={poolPairs}
                visibleLanes={visible}
                bridgesOnly={bridgesOnly}
                showAll={showAll}
              />
            ) : (
              <div data-testid="discovery-list" className="space-y-6">
                {graph.seeds.map((seed) => (
                  <section
                    key={seed.id}
                    aria-labelledby={`thread-${seed.id}`}
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <h3
                      id={`thread-${seed.id}`}
                      className="flex items-center gap-2 font-serif text-lg"
                    >
                      {seed.name} <DomainBadge domain={seed.domain} />
                    </h3>
                    {graph.lanes
                      .filter((l) => visible.has(l) && l !== seed.domain)
                      .map((lane) => {
                        const items = laneItems(graph, lane).filter(
                          (n) =>
                            n.seeds.includes(seed.id) &&
                            (!bridgesOnly || n.seeds.length > 1),
                        );
                        if (!items.length) return null;
                        return (
                          <div key={lane} className="mt-3">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {DOMAIN_LABEL[lane] ?? lane}
                            </h4>
                            <ol className="mt-1 space-y-1 text-sm">
                              {items.map((n) => (
                                <li key={n.entity.id} data-testid="list-item">
                                  <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-surface-2"
                                    onClick={() => setSelected(n.entity.id)}
                                  >
                                    <span>
                                      <span className="font-mono text-xs text-muted-foreground">
                                        #{n.bestPosition + 1}
                                      </span>{" "}
                                      {n.entity.name}
                                      {n.seeds.length > 1 ? (
                                        <span className="ml-2 text-xs text-weft">
                                          bridges {n.seeds.length} seeds
                                        </span>
                                      ) : null}
                                    </span>
                                    <ProvenanceChip
                                      provenance={n.entity.provenanceClass}
                                      origin={n.entity.dataOrigin}
                                    />
                                  </button>
                                </li>
                              ))}
                            </ol>
                          </div>
                        );
                      })}
                  </section>
                ))}
              </div>
            )}
            {selectedItem ? (
              <Inspector
                item={selectedItem}
                entities={graph.entities}
                onClose={() => setSelected(null)}
                onTrace={setTrace}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Lanes are domains (warp threads); positions follow Qloo&apos;s
            result order. Every number here is an aggregate audience-affinity
            signal.
            {graph.location ? (
              <>
                {" "}
                Venue locality:{" "}
                <span className="font-medium">{graph.location.name}</span>{" "}
                <DataOriginBadge origin={graph.location.dataOrigin} />
              </>
            ) : null}
          </p>
        </>
      ) : !pendingRows.length && !discovering ? (
        <EmptyState title="No threads yet.">
          Confirm your entities to start discovery.
        </EmptyState>
      ) : null}
      {!poolGateOpen ? poolPanel : null}
      {trace ? (
        <TraceDialog invocationId={trace} onClose={() => setTrace(null)} />
      ) : null}
    </div>
  );
}
