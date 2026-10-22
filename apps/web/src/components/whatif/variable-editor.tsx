"use client";

import { Play, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  BranchPreview,
  EntityView,
  ExperimentViewData,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { DOMAIN_LABEL, DomainBadge } from "../provenance";
import { Button, inputClass } from "../ui";
import { WeightsEditor, sameWeights, type Weights } from "./weights-editor";

const INSIGHT = [
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
];
const WEEKS = [4, 12, 26, 52] as const;

export interface DeltaState {
  swaps: Record<string, string>;
  removed: string[];
  domains: string[];
  location: string; // "" keep · "none" remove · entity id
  weeks: number;
  tension: number;
  weights: Weights;
  capacity: string;
  budgetBand: string;
  duration: string;
}

export function initialState(view: ExperimentViewData): DeltaState {
  const v = view.experiment.definition.variables;
  const c = v.constraints ?? {};
  const brief = view.brief?.content;
  return {
    swaps: {},
    removed: [],
    domains: [...v.targetDomains].sort(),
    location: "",
    weeks: v.timeWindowWeeks ?? 12,
    tension: v.collisionTension,
    weights: view.experiment.definition.scoringWeights,
    capacity: String(c.capacity ?? brief?.venue.capacity ?? ""),
    budgetBand: c.budgetBand ?? brief?.constraints.budgetBand ?? "",
    duration: String(
      c.durationMinutes ?? brief?.constraints.durationMinutes ?? "",
    ),
  };
}

/** Only what changed becomes part of the delta (an empty delta is not a branch). */
export function buildDelta(
  base: DeltaState,
  s: DeltaState,
): Record<string, unknown> | null {
  const delta: Record<string, unknown> = {};
  const swap = Object.entries(s.swaps)
    .filter(([, to]) => to)
    .map(([from, to]) => ({ from, to }));
  if (swap.length || s.removed.length)
    delta.seeds = {
      ...(swap.length ? { swap } : {}),
      ...(s.removed.length ? { remove: s.removed } : {}),
    };
  const add = s.domains.filter((d) => !base.domains.includes(d));
  const remove = base.domains.filter((d) => !s.domains.includes(d));
  if (add.length || remove.length)
    delta.targetDomains = {
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
    };
  if (s.location === "none") delta.location = null;
  else if (s.location) delta.location = { localityEntityId: s.location };
  if (s.weeks !== base.weeks) delta.timeWindow = { weeks: s.weeks };
  if (Math.abs(s.tension - base.tension) > 1e-9)
    delta.collisionTension = s.tension;
  if (!sameWeights(s.weights, base.weights)) delta.scoringWeights = s.weights;
  const constraints: Record<string, unknown> = {};
  if (s.capacity !== base.capacity && Number(s.capacity) > 0)
    constraints.capacity = Number(s.capacity);
  if (s.budgetBand !== base.budgetBand && s.budgetBand)
    constraints.budgetBand = s.budgetBand;
  if (s.duration !== base.duration && Number(s.duration) > 0)
    constraints.durationMinutes = Number(s.duration);
  if (Object.keys(constraints).length) delta.constraints = constraints;
  return Object.keys(delta).length ? delta : null;
}

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <fieldset className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <legend className="text-sm font-semibold">{title}</legend>
      {children}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </fieldset>
  );
}

/**
 * Variable editor and live dependency preview (UI_UX_SPEC §4.5). The preview is the same
 * deterministic plan the server stores with the branch, so the counts shown are what runs.
 */
export function VariableEditor({
  view,
  disabledReason,
  onRun,
}: {
  view: ExperimentViewData;
  disabledReason: string | null;
  onRun: (
    delta: Record<string, unknown>,
    label: string | null,
  ) => Promise<void>;
}) {
  const base = useMemo(() => initialState(view), [view]);
  const [state, setState] = useState<DeltaState>(base);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<{
    key: string;
    data: BranchPreview | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const delta = useMemo(() => buildDelta(base, state), [base, state]);
  const key = delta ? JSON.stringify(delta) : "";

  useEffect(() => {
    if (!delta || disabledReason) return;
    const timer = setTimeout(() => {
      void api
        .post<BranchPreview>(
          `/api/v1/experiments/${view.experiment.id}/branches/preview`,
          { delta },
        )
        .then((data) => setPreview({ key, data, error: null }))
        .catch((e: Error) => setPreview({ key, data: null, error: e.message }));
    }, 350);
    return () => clearTimeout(timer);
  }, [key, delta, view.experiment.id, disabledReason]);

  const current = preview?.key === key ? preview : null;
  const entities = new Map(view.entities.map((e) => [e.id, e]));
  const seeds = view.seeds
    .filter((s) => s.role === "seed")
    .map((s) => entities.get(s.entityId))
    .filter((e): e is EntityView => !!e);
  const seedIds = new Set(seeds.map((s) => s.id));
  const candidates = view.entities
    .filter(
      (e) =>
        e.kind === "entity" &&
        e.domain &&
        INSIGHT.includes(e.domain) &&
        !seedIds.has(e.id),
    )
    .sort(
      (a, b) =>
        (a.domain ?? "").localeCompare(b.domain ?? "") ||
        a.name.localeCompare(b.name),
    );
  const byDomain = new Map<string, EntityView[]>();
  for (const c of candidates)
    byDomain.set(c.domain!, [...(byDomain.get(c.domain!) ?? []), c]);
  const location = view.seeds.find((s) => s.role === "location");
  const localities = view.entities.filter(
    (e) => e.kind === "locality" && e.id !== location?.entityId,
  );
  const set = (patch: Partial<DeltaState>) =>
    setState((s) => ({ ...s, ...patch }));

  const run = async () => {
    if (!delta) return;
    setBusy(true);
    try {
      await onRun(delta, label.trim() || null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="variable-editor">
      <div className="space-y-5 rounded-xl border border-border bg-card p-4">
        <Section
          title="Seeds"
          note="Swap a seed for another entity from this experiment's discovery. Adding a brand-new seed needs entity search, which arrives with ad hoc resolution."
        >
          <ul className="space-y-2">
            {seeds.map((s) => {
              const removed = state.removed.includes(s.id);
              return (
                <li
                  key={s.id}
                  className={cn(
                    "rounded-lg border border-border p-2.5",
                    removed && "opacity-60",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <DomainBadge domain={s.domain} />
                    <label className="ml-auto flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={removed}
                        onChange={(e) =>
                          set({
                            removed: e.target.checked
                              ? [...state.removed, s.id]
                              : state.removed.filter((x) => x !== s.id),
                            swaps: { ...state.swaps, [s.id]: "" },
                          })
                        }
                      />
                      Remove
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <span className="shrink-0 text-muted-foreground">
                      Swap for
                    </span>
                    <select
                      className={cn(inputClass, "h-8 py-0 text-sm")}
                      value={state.swaps[s.id] ?? ""}
                      disabled={removed}
                      aria-label={`Swap ${s.name} for`}
                      onChange={(e) =>
                        set({
                          swaps: { ...state.swaps, [s.id]: e.target.value },
                        })
                      }
                    >
                      <option value="">Keep {s.name}</option>
                      {[...byDomain].map(([domain, list]) => (
                        <optgroup
                          key={domain}
                          label={DOMAIN_LABEL[domain] ?? domain}
                        >
                          {list.map((c) => (
                            <option
                              key={c.id}
                              value={c.id}
                              disabled={Object.entries(state.swaps).some(
                                ([from, to]) => to === c.id && from !== s.id,
                              )}
                            >
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
          <Button
            variant="secondary"
            size="sm"
            disabled
            title="Arrives with ad hoc entity resolution"
          >
            Add a seed
          </Button>
        </Section>

        <Section
          title="Target domains"
          note="Adding a domain runs discovery into it; removing one sets aside claims that target it."
        >
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Target domains"
          >
            {INSIGHT.map((d) => {
              const on = state.domains.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      domains: on
                        ? state.domains.filter((x) => x !== d)
                        : [...state.domains, d].sort(),
                    })
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    on
                      ? "border-warp bg-warp text-warp-ink"
                      : "border-border bg-surface hover:bg-surface-2",
                  )}
                >
                  {on ? "✓ " : "+ "}
                  {DOMAIN_LABEL[d] ?? d}
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          title="Location"
          note={
            localities.length
              ? "Location claims are re-tested in the new locality."
              : "Another locality needs a locality search, which arrives with ad hoc resolution."
          }
        >
          <select
            className={cn(inputClass, "h-9 py-0 text-sm")}
            aria-label="Venue locality"
            value={state.location}
            onChange={(e) => set({ location: e.target.value })}
          >
            <option value="">
              Keep{" "}
              {location
                ? (entities.get(location.entityId)?.name ?? "current locality")
                : "no locality"}
            </option>
            {location ? <option value="none">No locality</option> : null}
            {localities.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Section>

        <Section
          title="Time window"
          note="Only momentum (trend) claims depend on it."
        >
          <div
            className="flex rounded-md border border-border p-0.5"
            role="group"
            aria-label="Time window"
          >
            {WEEKS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={state.weeks === w}
                onClick={() => set({ weeks: w })}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-sm",
                  state.weeks === w
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-surface-2",
                )}
              >
                {w} wk
              </button>
            ))}
          </div>
        </Section>

        <Section
          title="Audience band and tag constraints"
          note="Aggregate audience signal — not a prediction about individuals. Disabled: the harness's demographic and tag-filter parameters are not confirmed yet (PENDING)."
        >
          <div className="flex flex-wrap gap-1.5" aria-disabled="true">
            {["Any", "18–24", "25–34", "35–44", "45–54", "55+"].map((b) => (
              <span
                key={b}
                className="cursor-not-allowed rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground"
              >
                {b}
              </span>
            ))}
          </div>
        </Section>

        <Section
          title="Collision tension"
          note="Re-selects the collision pool; held-fixed hypotheses keep their text."
        >
          <label className="flex items-center gap-3 text-xs">
            <span aria-hidden>Harmonious</span>
            <input
              type="range"
              min={0.2}
              max={0.9}
              step={0.05}
              value={state.tension}
              onChange={(e) => set({ tension: Number(e.target.value) })}
              aria-label="Collision tension"
              aria-valuetext={state.tension.toFixed(2)}
              className="flex-1 accent-[var(--tl-weft)]"
            />
            <span aria-hidden>Unexpected</span>
            <span className="w-10 text-right font-mono">
              {state.tension.toFixed(2)}
            </span>
          </label>
        </Section>

        <Section title="Scores">
          <WeightsEditor
            value={state.weights}
            onChange={(weights) => set({ weights })}
          />
        </Section>

        <Section title="Constraints" note="Feasibility only — no new data.">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs">
              Capacity
              <input
                type="number"
                min={1}
                className={cn(inputClass, "mt-1 h-9")}
                value={state.capacity}
                onChange={(e) => set({ capacity: e.target.value })}
              />
            </label>
            <label className="text-xs">
              Budget
              <select
                className={cn(inputClass, "mt-1 h-9 py-0")}
                value={state.budgetBand}
                onChange={(e) => set({ budgetBand: e.target.value })}
              >
                <option value="">Not set</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="text-xs">
              Duration (min)
              <input
                type="number"
                min={15}
                className={cn(inputClass, "mt-1 h-9")}
                value={state.duration}
                onChange={(e) => set({ duration: e.target.value })}
              />
            </label>
          </div>
        </Section>

        <Section title="Mode">
          <div className="flex flex-col gap-1.5 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked readOnly />
              Hold hypotheses{" "}
              <span className="text-xs text-muted-foreground">
                (recommended: isolates the change)
              </span>
            </label>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input type="radio" name="mode" disabled />
              Regenerate <span className="text-xs">(arrives later)</span>
            </label>
          </div>
        </Section>
      </div>

      <section
        aria-labelledby="preview-h"
        aria-live="polite"
        className={cn(
          "rounded-xl border-2 p-4",
          delta ? "border-weft bg-card" : "border-dashed border-border",
        )}
        data-testid="branch-preview"
      >
        <h3 id="preview-h" className="font-semibold">
          Preview
        </h3>
        {disabledReason ? (
          <p className="mt-1 text-sm text-muted-foreground">{disabledReason}</p>
        ) : !delta ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Change a variable to see which Qloo queries it affects.
          </p>
        ) : !current ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Checking dependencies…
          </p>
        ) : current.error ? (
          <p role="alert" className="mt-1 text-sm text-rust">
            {current.error}
          </p>
        ) : current.data!.unsupported.length ? (
          <ul role="alert" className="mt-1 list-disc pl-5 text-sm text-rust">
            {current.data!.unsupported.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        ) : current.data!.rescoreOnly ? (
          <p className="mt-1 text-sm" data-testid="preview-summary">
            <strong>No new Qloo data needed</strong> — scores will be recomputed
            from the {current.data!.reusedQueries} existing queries.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm" data-testid="preview-summary">
              This change affects{" "}
              <strong>
                {current.data!.dirtyQueries} Qloo{" "}
                {current.data!.dirtyQueries === 1 ? "query" : "queries"}
              </strong>
              ; <strong>{current.data!.reusedQueries}</strong> will be reused.
              Estimated {current.data!.estimatedQlooCalls}{" "}
              {current.data!.mode === "live" ? "live" : "fixture"} calls
              {current.data!.mode === "live"
                ? ` (${current.data!.qlooCallsToday} live calls used today across the studio)`
                : " (synthetic fixtures — no Qloo quota is used)"}
              .
            </p>
            {current.data!.needsConfirmation ? (
              <p className="mt-1 text-xs text-muted-foreground">
                More than 6 calls: you will be asked to confirm before they run.
              </p>
            ) : null}
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">
                Queries that will run
              </summary>
              <ul className="mt-1 space-y-0.5">
                {current.data!.dirtyList.map((d, i) => (
                  <li key={i}>
                    <span className="font-mono">{d.method}</span> — {d.label}{" "}
                    <span className="text-muted-foreground">({d.reason})</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        <label className="mt-3 block text-xs">
          Branch label (optional)
          <input
            className={cn(inputClass, "mt-1 h-9")}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Cozy mystery instead of noir"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="weft"
            onClick={run}
            disabled={
              busy ||
              !delta ||
              !!disabledReason ||
              !current?.data ||
              current.data.unsupported.length > 0
            }
          >
            <Play aria-hidden className="size-4" /> Run branch
          </Button>
          <Button
            variant="ghost"
            onClick={() => setState(base)}
            disabled={!delta}
          >
            <RotateCcw aria-hidden className="size-4" /> Reset
          </Button>
        </div>
      </section>
    </div>
  );
}
