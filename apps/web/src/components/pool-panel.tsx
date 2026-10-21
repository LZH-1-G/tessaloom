"use client";

import { selectPool, type PoolSelection } from "@tessaloom/core";
import { Shuffle } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { EntityView, ExperimentViewData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DomainBadge } from "./provenance";
import { Button } from "./ui";

export interface PoolRow {
  key: string;
  id: string;
  elements: EntityView[];
  relevance: number;
  novelty: number;
  noveltyInputs: "FULL" | "REDUCED_INPUTS";
  tensionFit: number;
  storedSelected: boolean;
  rank: number | null;
}

/** Stored candidates keyed exactly like the server's re-selection (elements joined by "|"). */
export function poolRows(view: ExperimentViewData): PoolRow[] {
  const byId = new Map(view.entities.map((e) => [e.id, e]));
  return view.pool.flatMap((p) => {
    const elements = p.elementEntityIds.map((id) => byId.get(id));
    if (elements.some((e) => !e)) return [];
    return [
      {
        key: p.elementEntityIds.join("|"),
        id: p.id,
        elements: elements as EntityView[],
        relevance: p.relevance,
        novelty: p.novelty,
        noveltyInputs: p.noveltyInputs,
        tensionFit: p.tensionFit,
        storedSelected: p.selected,
        rank: p.rank,
      },
    ];
  });
}

/** Gate open: preview the server's re-selection at τ. Committed: the stored ranks. */
export function poolSelection(
  rows: PoolRow[],
  gateOpen: boolean,
  tension: number,
): PoolSelection[] {
  if (!gateOpen)
    return rows
      .filter((r) => r.storedSelected)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((r, i) => ({
        key: r.key,
        rank: r.rank ?? i + 1,
        tensionFit: r.tensionFit,
        score: 0,
      }));
  return selectPool(
    rows.map((r) => ({
      key: r.key,
      elementEntityIds: [r.elements[0]!.id, r.elements[1]!.id] as [
        string,
        string,
      ],
      domains: [
        r.elements[0]!.domain ?? "unknown",
        r.elements[1]!.domain ?? "unknown",
      ] as [string, string],
      relevance: r.relevance,
      novelty: r.novelty,
    })),
    tension,
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value.toFixed(2)}</span>
      </div>
      <div className="mt-0.5 h-1 rounded-full bg-surface-2" aria-hidden>
        <div
          className="h-full rounded-full bg-weft"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
    </div>
  );
}

const tensionWord = (t: number) =>
  t < 0.4 ? "Harmonious" : t < 0.65 ? "Balanced" : "Unexpected";

/**
 * Collision pool review (UI_UX_SPEC §4.3; gate H2b, ADR-025). Moving the slider re-selects the
 * pool client-side from stored scores; committing continues the run with that selection.
 */
export function PoolPanel({
  rows,
  selection,
  gateOpen,
  runId,
  tension,
  onTension,
  onDone,
}: {
  rows: PoolRow[];
  selection: PoolSelection[];
  gateOpen: boolean;
  runId: string | null;
  tension: number;
  onTension: (t: number) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const changed = gateOpen
    ? selection.filter((s) => !byKey.get(s.key)?.storedSelected).length
    : 0;
  const reduced = rows.filter(
    (r) => r.noveltyInputs === "REDUCED_INPUTS",
  ).length;

  const commit = async () => {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/runs/${runId}/confirmations`, {
        kind: "POOL",
        tension,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="pool-heading"
      className={cn(
        "rounded-xl border bg-card p-5",
        gateOpen ? "border-2 border-saffron" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pool-heading" className="font-serif text-2xl">
            Collision pool
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Pairs of elements from different worlds that share a thread or a
            tag. Relevance follows Qloo&apos;s ordering; novelty is computed
            from tags and domain distance. Tension chooses between familiar and
            surprising pairings.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {rows.length} bridges · {selection.length} selected
          {reduced ? ` · ${reduced} scored with reduced inputs` : ""}
        </p>
      </div>

      <div className="mt-5">
        <label htmlFor="tension" className="text-sm font-medium">
          Collision tension:{" "}
          <span className="text-weft">{tensionWord(tension)}</span>{" "}
          <span className="font-mono text-xs text-muted-foreground">
            τ = {tension.toFixed(2)}
          </span>
        </label>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <span aria-hidden>Harmonious</span>
          <input
            id="tension"
            type="range"
            min={0.2}
            max={0.9}
            step={0.05}
            value={tension}
            disabled={!gateOpen}
            onChange={(e) => onTension(Number(e.target.value))}
            aria-valuetext={`${tensionWord(tension)}, ${tension.toFixed(2)}`}
            className="h-2 flex-1 accent-[var(--tl-weft)]"
          />
          <span aria-hidden>Unexpected</span>
        </div>
        {gateOpen ? (
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {changed} of {selection.length} candidates differ from the pool the
            agent proposed.
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            The pool was committed; hypotheses were woven from these candidates.
          </p>
        )}
      </div>

      <ol className="mt-4 divide-y divide-border" data-testid="pool-list">
        {selection.map((s) => {
          const row = byKey.get(s.key)!;
          return (
            <li
              key={s.key}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 py-2.5 lg:grid-cols-[1.5rem_minmax(0,1fr)_6rem_6rem_6rem_7rem]"
              data-testid="pool-item"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {s.rank}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                {row.elements.map((e, i) => (
                  <span key={e.id} className="flex items-center gap-1.5">
                    {i > 0 ? (
                      <Shuffle
                        aria-label="collides with"
                        className="size-3.5 text-weft"
                      />
                    ) : null}
                    <span className="font-medium">{e.name}</span>
                    <DomainBadge domain={e.domain} />
                  </span>
                ))}
              </span>
              {/* Narrow: one row of bars under the pair; wide: aligned table columns. */}
              <div className="col-start-2 grid grid-cols-3 gap-3 lg:contents">
                <Bar label="Relevance" value={row.relevance} />
                <Bar label="Novelty" value={row.novelty} />
                <Bar label="Tension fit" value={s.tensionFit} />
              </div>
              <span className="col-start-2 lg:col-start-auto">
                {row.noveltyInputs === "REDUCED_INPUTS" ? (
                  <span
                    className="inline-block rounded border border-dashed border-muted-foreground px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
                    title="No Qloo tags for one element: novelty uses domain distance only"
                  >
                    Reduced inputs
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rust">
          {error}
        </p>
      ) : null}
      {gateOpen ? (
        <Button
          variant="weft"
          className="mt-4"
          onClick={commit}
          disabled={busy || selection.length < 3}
        >
          Generate hypotheses with this pool
        </Button>
      ) : null}
    </section>
  );
}
