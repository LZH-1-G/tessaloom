"use client";

import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { BranchItem, ComparisonRow, EntityView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useProject } from "../project-context";
import { StatusPill } from "../provenance";
import { Button, EmptyState, SectionTitle, Skeleton } from "../ui";
import { ComposeDialog } from "../blueprint/compose-dialog";
import { ComparisonView } from "./comparison-view";
import { VariableEditor } from "./variable-editor";

const BRANCHABLE = [
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "AWAITING_HYPOTHESIS_SELECTION",
];
const TERMINAL = ["COMPLETED", "COMPLETED_WITH_LIMITS", "FAILED", "CANCELLED"];

/** One-line summary of a stored delta for the branch tree. */
export function describeDelta(
  delta: Record<string, unknown> | null,
  names: Map<string, string>,
): string {
  if (!delta) return "Original experiment";
  const out: string[] = [];
  const d = delta as {
    seeds?: { swap?: { from: string; to: string }[]; remove?: string[] };
    targetDomains?: { add?: string[]; remove?: string[] };
    location?: { localityEntityId: string } | null;
    timeWindow?: { weeks: number };
    collisionTension?: number;
    scoringWeights?: { support: number; novelty: number; feasibility: number };
    constraints?: Record<string, unknown>;
  };
  for (const s of d.seeds?.swap ?? [])
    out.push(`${names.get(s.from) ?? "seed"} → ${names.get(s.to) ?? "entity"}`);
  for (const r of d.seeds?.remove ?? [])
    out.push(`− ${names.get(r) ?? "seed"}`);
  for (const a of d.targetDomains?.add ?? [])
    out.push(`+ ${a.replace("_", " ")}`);
  for (const r of d.targetDomains?.remove ?? [])
    out.push(`− ${r.replace("_", " ")}`);
  if (d.location !== undefined)
    out.push(
      d.location
        ? `in ${names.get(d.location.localityEntityId) ?? "a new locality"}`
        : "no locality",
    );
  if (d.timeWindow) out.push(`${d.timeWindow.weeks}-week trends`);
  if (d.collisionTension !== undefined)
    out.push(`tension ${d.collisionTension.toFixed(2)}`);
  if (d.scoringWeights)
    out.push(
      `weights ${Math.round(d.scoringWeights.support * 100)}/${Math.round(d.scoringWeights.novelty * 100)}/${Math.round(d.scoringWeights.feasibility * 100)}`,
    );
  if (d.constraints)
    out.push(
      Object.entries(d.constraints)
        .map(([k, v]) => `${k.replace("Minutes", "")} ${String(v)}`)
        .join(", "),
    );
  return out.join(" · ") || "Change";
}

/** What-if Lab (UI_UX_SPEC §4.5): branch tree, variable editor with preview, comparison. */
export function WhatIfLab() {
  const {
    projectId,
    view,
    explorationRun,
    loading,
    focusView,
    setFocusExperiment,
    refresh,
  } = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("branch");
  const [branches, setBranches] = useState<BranchItem[] | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<string>("");
  const [composeBranch, setComposeBranch] = useState(false);
  const rootRun = explorationRun;
  const focusRun = focusView?.runs[0] ?? null;

  // The dock follows the selected branch's run.
  useEffect(() => {
    setFocusExperiment(selected);
    return () => setFocusExperiment(null);
  }, [selected, setFocusExperiment]);

  const loadBranches = useCallback(() => {
    if (!view) return;
    void api
      .get<{ items: BranchItem[] }>(
        `/api/v1/experiments/${view.experiment.id}/branches`,
      )
      .then((r) => setBranches(r.items))
      .catch((e: Error) => setError(e.message));
  }, [view]);
  useEffect(loadBranches, [loadBranches, focusRun?.state]);

  const current = branches?.find((b) => b.id === selected) ?? null;
  const comparisonId = current?.comparisonId ?? null;
  useEffect(() => {
    if (!comparisonId) return;
    let cancelled = false;
    void api
      .get<ComparisonRow>(`/api/v1/comparisons/${comparisonId}`)
      .then((c) => {
        if (!cancelled) setComparison(c);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [comparisonId]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of [
      ...(view?.entities ?? []),
      ...(focusView?.entities ?? []),
    ] as EntityView[]) {
      m.set(e.id, e.name);
      m.set(e.qlooId, e.name);
    }
    return m;
  }, [view, focusView]);

  if (loading) return <Skeleton className="h-96" />;
  if (!view || !view.hypotheses.length)
    return (
      <div>
        <SectionTitle eyebrow="Step 4" title="What-if lab" />
        <EmptyState title="Nothing to branch yet.">
          Run the hypothesis loop first; then change a variable here and
          compare.
        </EmptyState>
      </div>
    );

  const select = (id: string | null) =>
    router.replace(
      `/projects/${projectId}/what-if${id ? `?branch=${id}` : ""}`,
    );
  const disabledReason =
    rootRun && BRANCHABLE.includes(rootRun.state)
      ? null
      : "Branching is available once the hypothesis loop has finished.";

  const runBranch = async (
    delta: Record<string, unknown>,
    label: string | null,
  ) => {
    setError(null);
    try {
      const res = await api.post<{
        branchExperimentId: string;
        reused: boolean;
      }>(`/api/v1/experiments/${view.experiment.id}/branches`, {
        delta,
        mode: "hold_hypotheses",
        ...(label ? { label } : {}),
      });
      setComparison(null);
      select(res.branchExperimentId);
      loadBranches();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const answerGate = async (action: "run" | "cancel") => {
    if (!focusRun) return;
    setError(null);
    try {
      await api.post(`/api/v1/runs/${focusRun.id}/confirmations`, {
        kind: "COUNTERFACTUAL_COST",
        action,
        ...(action === "run" && Number(cap) > 0
          ? { maxQlooCalls: Number(cap) }
          : {}),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pending = focusRun?.pendingConfirmation as
    | {
        kind: string;
        estimatedQlooCalls?: number;
        reusedQueries?: number;
        maxQlooCalls?: number;
      }
    | null
    | undefined;
  const root = branches?.find((b) => b.kind === "ROOT");
  const children = branches?.filter((b) => b.kind === "BRANCH") ?? [];

  return (
    <div className="space-y-6">
      <SectionTitle eyebrow="Step 4" title="What-if lab" />
      <p className="-mt-3 max-w-3xl text-sm text-muted-foreground">
        Change one variable, keep the hypotheses fixed, and see exactly which
        evidence moves. Only the Qloo queries that depend on your change run
        again; everything else is reused and labeled.
      </p>

      <nav
        aria-label="Branches"
        className="rounded-xl border border-border bg-card p-3"
      >
        <ol
          className="flex flex-wrap items-center gap-2"
          data-testid="branch-tree"
        >
          <li>
            <button
              type="button"
              onClick={() => select(null)}
              aria-current={!selected ? "true" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm",
                !selected
                  ? "border-warp bg-warp text-warp-ink"
                  : "border-border hover:bg-surface-2",
              )}
            >
              <GitCommitHorizontal aria-hidden className="size-4" /> Original
              {root?.latestRun ? (
                <span className="text-xs">
                  · {root.latestRun.state.replace(/_/g, " ").toLowerCase()}
                </span>
              ) : null}
            </button>
          </li>
          {children.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => select(b.id)}
                aria-current={selected === b.id ? "true" : undefined}
                className={cn(
                  "flex max-w-[22rem] items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-sm",
                  selected === b.id
                    ? "border-weft bg-weft text-white"
                    : "border-border hover:bg-surface-2",
                )}
              >
                <GitBranch aria-hidden className="size-4 shrink-0" />
                <span className="truncate">
                  {b.label ?? describeDelta(b.variableDelta, names)}
                </span>
                <span className="shrink-0 text-xs">
                  ·{" "}
                  {b.latestRun
                    ? b.latestRun.state.replace(/_/g, " ").toLowerCase()
                    : "pending"}
                </span>
              </button>
            </li>
          ))}
          {!children.length ? (
            <li className="text-xs text-muted-foreground">No branches yet.</li>
          ) : null}
        </ol>
      </nav>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rust/60 bg-rust/5 p-3 text-sm text-rust"
        >
          {error}
        </p>
      ) : null}

      {/* The selected branch's comparison is the task at hand; the editor stays one click away. */}
      <div className="flex flex-col gap-6">
        <details
          className="order-2 rounded-xl border border-border bg-surface/60 p-4 open:bg-transparent"
          open={!current}
          key={current ? "with-branch" : "no-branch"}
        >
          <summary className="cursor-pointer font-serif text-xl">
            {current ? "Start another branch" : "Change a variable"}
          </summary>
          <div className="mt-4 max-w-3xl">
            <VariableEditor
              view={view}
              disabledReason={disabledReason}
              onRun={runBranch}
            />
          </div>
        </details>
        <div className={cn("min-w-0", current ? "order-1" : "order-3")}>
          <h2 className="mb-3 font-serif text-xl">
            {current ? "Parent vs. branch" : "Comparison"}
          </h2>
          {!current ? (
            <EmptyState title="No branch selected.">
              Run a branch, or pick one above, to compare it with the original.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                <span className="text-muted-foreground">Change: </span>
                <strong>{describeDelta(current.variableDelta, names)}</strong>
                {current.plannedDirtyQueries !== null ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · planned {current.plannedDirtyQueries} re-run,{" "}
                    {current.plannedReusedQueries} reused
                  </span>
                ) : null}
              </p>
              {pending?.kind === "COUNTERFACTUAL_COST" &&
              focusRun?.state === "AWAITING_COUNTERFACTUAL_CONFIRMATION" ? (
                <section
                  className="rounded-xl border-2 border-saffron bg-saffron-tint p-4"
                  aria-labelledby="h4-title"
                  data-testid="cost-gate"
                >
                  <h3 id="h4-title" className="font-semibold">
                    Approve {pending.estimatedQlooCalls} Qloo calls?
                  </h3>
                  <p className="mt-1 text-sm">
                    This branch needs {pending.estimatedQlooCalls} new queries (
                    {pending.reusedQueries} reused). You can lower the cap;
                    claims beyond it are marked untested.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    Cap
                    <input
                      type="number"
                      min={1}
                      max={pending.maxQlooCalls ?? 15}
                      value={cap}
                      placeholder={String(pending.maxQlooCalls ?? 15)}
                      onChange={(e) => setCap(e.target.value)}
                      className="h-8 w-20 rounded border border-border bg-surface px-2"
                    />
                  </label>
                  <div className="mt-3 flex gap-2">
                    <Button variant="weft" onClick={() => answerGate("run")}>
                      Run
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => answerGate("cancel")}
                    >
                      Cancel branch
                    </Button>
                  </div>
                </section>
              ) : null}
              {focusRun &&
              !TERMINAL.includes(focusRun.state) &&
              focusRun.state !== "AWAITING_COUNTERFACTUAL_CONFIRMATION" ? (
                <p
                  role="status"
                  className="rounded-lg border border-border bg-card p-4 text-sm"
                >
                  The branch is running (
                  {focusRun.state.replace(/_/g, " ").toLowerCase()}). The
                  comparison appears when it finishes.
                </p>
              ) : null}
              {focusRun && ["CANCELLED", "FAILED"].includes(focusRun.state) ? (
                <p className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm">
                  <StatusPill status={focusRun.state} /> This branch did not
                  finish:{" "}
                  {focusRun.terminalReason?.replace(/_/g, " ").toLowerCase()}.
                </p>
              ) : null}
              {focusRun?.state === "COMPLETED" && focusView ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
                  <span className="flex-1">
                    Like this branch? Compose a blueprint from its hypotheses —
                    its evidence is cited exactly as in the comparison.
                  </span>
                  <Button
                    variant="weft"
                    size="sm"
                    onClick={() => setComposeBranch(true)}
                  >
                    Compose a blueprint from this branch
                  </Button>
                </div>
              ) : null}
              {composeBranch && focusView ? (
                <ComposeDialog
                  projectId={projectId}
                  experimentId={focusView.experiment.id}
                  choices={focusView.hypotheses
                    .filter((h) => !h.retired)
                    .sort(
                      (a, b) =>
                        (b.compositeScore ?? 0) - (a.compositeScore ?? 0),
                    )
                    .map((h) => ({
                      id: h.id,
                      title: h.title,
                      status: h.status,
                      compositeScore: h.compositeScore,
                    }))}
                  preselected={focusView.hypotheses
                    .filter((h) => !h.retired)
                    .sort(
                      (a, b) =>
                        (b.compositeScore ?? 0) - (a.compositeScore ?? 0),
                    )
                    .slice(0, 1)
                    .map((h) => h.id)}
                  source={`From the What-if branch: ${describeDelta(current.variableDelta, names)}`}
                  onClose={() => setComposeBranch(false)}
                />
              ) : null}
              {comparison && comparison.id === comparisonId ? (
                <ComparisonView comparison={comparison} names={names} />
              ) : comparisonId ? (
                <Skeleton className="h-64" />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
