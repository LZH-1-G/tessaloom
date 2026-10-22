"use client";

import {
  ChevronDown,
  FlaskConical,
  Shuffle,
  SlidersHorizontal,
} from "lucide-react";
import { useId, useState } from "react";
import { breakdownOf, stanceCounts } from "@/lib/hypothesis-view";
import type { EntityView, HypothesisRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useProject } from "./project-context";
import { AdjustWeightsDialog } from "./whatif/adjust-weights";
import { DomainBadge, ProvenanceChip, StatusPill } from "./provenance";
import { Button } from "./ui";

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">
          {value === null ? "—" : Math.round(value)}
        </span>
      </div>
      <div
        className="mt-0.5 h-1.5 rounded-full bg-surface-2"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? 0}
      >
        <div
          className="h-full rounded-full bg-warp"
          style={{ width: `${Math.round(value ?? 0)}%` }}
        />
      </div>
    </div>
  );
}

/** Score breakdown (UI_UX_SPEC §4.4): weights, inputs, and every feasibility rule applied. */
export function ScoreBreakdown({ h }: { h: HypothesisRow }) {
  const b = breakdownOf(h);
  const rows: [string, number | null, number | undefined][] = [
    ["Support", h.supportScore, b.weightSupport],
    ["Novelty", h.noveltyScore, b.weightNovelty],
    ["Feasibility", h.feasibilityScore, b.weightFeasibility],
  ];
  return (
    <div className="space-y-3 text-xs" data-testid="score-breakdown">
      <table className="w-full text-left">
        <caption className="sr-only">Composite score inputs</caption>
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Input</th>
            <th className="py-1 font-medium">Score</th>
            <th className="py-1 font-medium">Weight</th>
            <th className="py-1 text-right font-medium">Contribution</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map(([label, score, weight]) => (
            <tr key={label} className="border-t border-border">
              <td className="py-1 font-sans">{label}</td>
              <td className="py-1">{score ?? "—"}</td>
              <td className="py-1">{weight ?? "—"}</td>
              <td className="py-1 text-right">
                {score !== null && weight !== undefined
                  ? (score * weight).toFixed(1)
                  : "—"}
              </td>
            </tr>
          ))}
          <tr className="border-t border-border font-semibold">
            <td className="py-1 font-sans">Composite</td>
            <td />
            <td />
            <td className="py-1 text-right">{h.compositeScore ?? "—"}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-muted-foreground">
        Support maps tested claims from −1 (all contradict) to +1 (all support)
        onto 0–100; {b.testedClaims ?? 0} decisive or insufficient claim
        {b.testedClaims === 1 ? "" : "s"} counted; neutral results are left out.
      </p>
      <p className="text-muted-foreground">
        Novelty comes from the collision pair
        {b.noveltyInputs === "REDUCED_INPUTS"
          ? " — scored with reduced inputs (no Qloo tags for one element; domain distance only)."
          : " — tag overlap and domain distance."}
      </p>
      {b.feasibility ? (
        <div>
          <p className="font-semibold">
            Feasibility rules{" "}
            <span className="font-mono font-normal text-muted-foreground">
              {b.feasibility.version}
            </span>
          </p>
          {b.feasibility.rules.length ? (
            <ul className="mt-1 space-y-0.5">
              {b.feasibility.rules.map((r, i) => (
                <li key={i}>
                  <span
                    className={cn(
                      "font-mono",
                      r.effect < 0 ? "text-rust" : "text-moss",
                    )}
                  >
                    {r.effect > 0 ? "+" : ""}
                    {r.effect.toFixed(2)}
                  </span>{" "}
                  {r.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No brief constraint was violated (base 0.80: plausible, not
              proven).
            </p>
          )}
        </div>
      ) : null}
      <AdjustWeights hypothesisId={h.id} />
    </div>
  );
}

const BRANCHABLE = [
  "COMPLETED",
  "COMPLETED_WITH_LIMITS",
  "AWAITING_HYPOTHESIS_SELECTION",
];

/** Re-weighting opens a rescore-only branch (M8); the original experiment never changes. */
function AdjustWeights({ hypothesisId }: { hypothesisId: string }) {
  const { projectId, view, run } = useProject();
  const [open, setOpen] = useState(false);
  const ready = !!view && !!run && BRANCHABLE.includes(run.state);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={!ready}
        aria-describedby={`${hypothesisId}-weights-note`}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" /> Adjust weights
      </Button>
      <span
        id={`${hypothesisId}-weights-note`}
        className="text-muted-foreground"
      >
        {ready
          ? "Creates a rescore-only branch in the What-if lab (no new Qloo data)."
          : "Available once the hypothesis loop has finished."}
      </span>
      {open && view ? (
        <AdjustWeightsDialog
          projectId={projectId}
          experimentId={view.experiment.id}
          current={view.experiment.definition.scoringWeights}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function HypothesisCard({
  h,
  entities,
  selectable,
  selected,
  onToggle,
  onInspect,
  muted,
}: {
  h: HypothesisRow;
  entities: Map<string, EntityView>;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onInspect: () => void;
  muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const counts = stanceCounts(h);
  return (
    <article
      aria-labelledby={`${h.id}-title`}
      data-testid="hypothesis-card"
      className={cn(
        "flex flex-col rounded-xl border bg-card p-4 transition-shadow",
        selected ? "border-2 border-weft shadow-md" : "border-border",
        muted && "opacity-80",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={h.status} />
          {h.userPinned ? (
            <span className="rounded bg-weft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
              Selected
            </span>
          ) : null}
          {h.revisionOfId ? (
            <span className="text-[11px] text-muted-foreground">
              revised · it. {h.iteration + 1}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              it. {h.iteration + 1}
            </span>
          )}
        </div>
        <p className="text-right">
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            Composite
          </span>
          <span className="font-serif text-2xl leading-none">
            {h.compositeScore === null ? "—" : Math.round(h.compositeScore)}
          </span>
        </p>
      </div>
      <h3 id={`${h.id}-title`} className="mt-2 font-serif text-xl leading-snug">
        {h.title}
      </h3>
      <p className="mt-1.5 flex flex-wrap items-center gap-1 text-sm">
        {h.elements.map((el, i) => {
          const e = entities.get(el.entityId);
          return (
            <span key={el.entityId} className="flex items-center gap-1">
              {i > 0 ? (
                <Shuffle
                  aria-label="collides with"
                  className="size-3 text-weft"
                />
              ) : null}
              <span className="font-medium">
                {e?.name ?? "Unknown element"}
              </span>
              <DomainBadge domain={e?.domain ?? null} />
            </span>
          );
        })}
      </p>
      <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
        <ProvenanceChip
          provenance="CREATIVE_SPECULATION"
          className="mr-1 align-middle"
        />
        {h.premise}
      </p>
      <p className="mt-2 text-xs" aria-label="Claim results">
        <span className="text-moss">✔ {counts.SUPPORTS} supports</span> ·{" "}
        <span className="text-rust">✖ {counts.CONTRADICTS} contradicts</span> ·{" "}
        <span className="text-slate">– {counts.NEUTRAL} neutral</span> ·{" "}
        <span className="text-muted-foreground">
          ◌ {counts.INSUFFICIENT} insufficient
        </span>
        {counts.untested ? <> · {counts.untested} untested</> : null}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <ScoreBar label="Support" value={h.supportScore} />
        <ScoreBar label="Novelty" value={h.noveltyScore} />
        <ScoreBar label="Feasible" value={h.feasibilityScore} />
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Button variant="primary" size="sm" onClick={onInspect}>
          <FlaskConical aria-hidden className="size-3.5" /> Inspect evidence
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          Score breakdown
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
        </Button>
        {selectable ? (
          <label className="ml-auto flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={selected} onChange={onToggle} />
            Select
          </label>
        ) : null}
      </div>
      {open ? (
        <div id={panelId} className="mt-3 rounded-lg bg-surface-2/60 p-3">
          <ScoreBreakdown h={h} />
        </div>
      ) : null}
    </article>
  );
}
