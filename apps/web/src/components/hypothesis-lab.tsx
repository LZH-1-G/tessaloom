"use client";

import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { groupHypotheses, iterationTimeline } from "@/lib/hypothesis-view";
import type { EvidenceView } from "@/lib/types";
import { EvidenceDrawer } from "./evidence-drawer";
import { HypothesisCard } from "./hypothesis-card";
import { useProject } from "./project-context";
import { StatusPill } from "./provenance";
import { TraceDialog } from "./trace-dialog";
import { Button, EmptyState, SectionTitle, Skeleton } from "./ui";

const WORKING = [
  "GENERATING_HYPOTHESES",
  "PLANNING_EVIDENCE",
  "COLLECTING_EVIDENCE",
  "EVALUATING_EVIDENCE",
  "REVISING_HYPOTHESES",
];

/** Hypothesis Lab (UI_UX_SPEC §4.4): the evidence-graded board, drawer, timeline and gate H3. */
export function HypothesisLab() {
  const { view, run, refresh, loading } = useProject();
  const [drawer, setDrawer] = useState<string | null>(null);
  const [trace, setTrace] = useState<EvidenceView | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hyps = useMemo(() => view?.hypotheses ?? [], [view]);
  const groups = useMemo(() => groupHypotheses(hyps), [hyps]);
  const timeline = useMemo(() => iterationTimeline(hyps), [hyps]);
  const entities = useMemo(
    () => new Map((view?.entities ?? []).map((e) => [e.id, e])),
    [view],
  );

  if (loading) return <Skeleton className="h-96" />;
  const gateOpen = run?.state === "AWAITING_HYPOTHESIS_SELECTION";
  const working = run && WORKING.includes(run.state);
  const open = drawer ? hyps.find((h) => h.id === drawer) : undefined;

  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id)
        ? p.filter((x) => x !== id)
        : p.length < 3
          ? [...p, id]
          : p,
    );
  const finish = async (ids: string[]) => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/runs/${run.id}/confirmations`, {
        kind: "HYPOTHESIS_SELECTION",
        selectedHypothesisIds: ids,
      });
      setPicked([]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={gateOpen ? "pb-28" : undefined}>
      <SectionTitle eyebrow="Step 3" title="Hypothesis lab" />

      {timeline.length ? (
        <nav aria-label="Iterations" className="mb-5">
          <ol
            className="flex flex-wrap items-center gap-1 text-sm"
            data-testid="iteration-timeline"
          >
            {timeline.map((t, i) => (
              <li key={t.iteration} className="flex items-center gap-1">
                {i > 0 ? (
                  <ChevronRight
                    aria-hidden
                    className="size-4 text-muted-foreground"
                  />
                ) : null}
                <span className="rounded-full border border-border bg-card px-3 py-1">
                  <span className="font-semibold">Iteration {t.iteration}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {t.iteration === 1
                      ? `${t.woven} woven`
                      : [
                          t.refined && `${t.refined} refined`,
                          t.spawned && `${t.spawned} spawned`,
                        ]
                          .filter(Boolean)
                          .join(", ") || "re-evaluated"}
                  </span>
                </span>
              </li>
            ))}
            {groups.retired.length ? (
              <li className="ml-2 text-xs text-muted-foreground">
                {groups.retired.filter((r) => !r.supersededBy).length} retired ·{" "}
                {groups.retired.filter((r) => r.supersededBy).length} superseded
              </li>
            ) : null}
          </ol>
        </nav>
      ) : null}

      {working ? (
        <p
          role="status"
          className="mb-5 rounded-lg border border-border bg-card p-4 text-sm"
        >
          The agent is weaving and testing hypotheses — cards update as evidence
          arrives.
        </p>
      ) : null}

      {hyps.length === 0 ? (
        <EmptyState title="No hypotheses yet.">
          Confirm the collision pool on the Discovery page to start the
          hypothesis loop.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {groups.active.map((g) => (
            <section key={g.status} aria-labelledby={`group-${g.status}`}>
              <h2
                id={`group-${g.status}`}
                className="mb-3 flex items-center gap-2 text-sm font-semibold"
              >
                <StatusPill status={g.status} />
                <span className="text-muted-foreground">{g.items.length}</span>
              </h2>
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {g.items.map((h) => (
                  <HypothesisCard
                    key={h.id}
                    h={h}
                    entities={entities}
                    selectable={gateOpen}
                    selected={picked.includes(h.id)}
                    onToggle={() => toggle(h.id)}
                    onInspect={() => setDrawer(h.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {groups.retired.length ? (
            <details
              className="rounded-lg border border-border bg-card/60 p-4"
              data-testid="retired-group"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                Retired ({groups.retired.length}) — kept visible, because honest
                negative results matter
              </summary>
              <div className="mt-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {groups.retired.map(({ hypothesis: h, supersededBy }) => (
                  <div key={h.id}>
                    <p className="mb-1 text-xs text-muted-foreground">
                      {supersededBy
                        ? `Superseded by “${supersededBy.title}”`
                        : "Retired by the agent"}
                    </p>
                    <HypothesisCard
                      h={h}
                      entities={entities}
                      selectable={false}
                      selected={false}
                      onToggle={() => undefined}
                      onInspect={() => setDrawer(h.id)}
                      muted
                    />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}

      {gateOpen ? (
        <div
          role="region"
          aria-label="Select hypotheses"
          className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-saffron bg-card/95 px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <p className="text-sm">
              <span className="font-semibold">Select 1–3 hypotheses</span> to
              carry forward ·{" "}
              <span aria-live="polite">{picked.length} selected</span>
            </p>
            {error ? (
              <p role="alert" className="text-sm text-rust">
                {error}
              </p>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => finish([])}
                disabled={busy}
              >
                Finish without selecting
              </Button>
              <Button
                variant="secondary"
                disabled
                aria-describedby="compose-note"
              >
                Compose blueprint
              </Button>
              <Button
                variant="weft"
                onClick={() => finish(picked)}
                disabled={busy || picked.length === 0}
              >
                Save selection and finish
              </Button>
            </div>
            <p
              id="compose-note"
              className="w-full text-right text-[11px] text-muted-foreground"
            >
              Blueprint composition arrives in M9; your selection is saved for
              it.
            </p>
          </div>
        </div>
      ) : null}

      {open ? (
        <EvidenceDrawer
          hypothesis={open}
          entities={entities}
          onClose={() => setDrawer(null)}
          onTrace={setTrace}
        />
      ) : null}
      {trace ? (
        <TraceDialog
          evidenceId={trace.id}
          rule={trace.rationale ?? undefined}
          onClose={() => setTrace(null)}
        />
      ) : null}
    </div>
  );
}
