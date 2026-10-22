"use client";

import { useId } from "react";

export type Weights = { support: number; novelty: number; feasibility: number };
const KEYS: (keyof Weights)[] = ["support", "novelty", "feasibility"];
const LABEL: Record<keyof Weights, string> = {
  support: "Support (evidence)",
  novelty: "Novelty",
  feasibility: "Feasibility",
};

/**
 * Re-balance after one weight changes: the other two keep their ratio and the three always
 * sum to exactly 1 (integer percentages, so ScoringWeights' sum check holds).
 */
export function rebalance(
  weights: Weights,
  key: keyof Weights,
  percent: number,
): Weights {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const others = KEYS.filter((k) => k !== key);
  const rest = 100 - p;
  const a = Math.round(weights[others[0]!] * 100);
  const b = Math.round(weights[others[1]!] * 100);
  const first =
    a + b === 0 ? Math.round(rest / 2) : Math.round((rest * a) / (a + b));
  const out = {
    [key]: p,
    [others[0]!]: first,
    [others[1]!]: rest - first,
  } as Record<keyof Weights, number>;
  return {
    support: out.support / 100,
    novelty: out.novelty / 100,
    feasibility: out.feasibility / 100,
  };
}

export const sameWeights = (a: Weights, b: Weights) =>
  KEYS.every((k) => Math.round(a[k] * 100) === Math.round(b[k] * 100));

/** Three linked sliders that always sum to 100% (UI_UX_SPEC §4.5). */
export function WeightsEditor({
  value,
  onChange,
}: {
  value: Weights;
  onChange: (w: Weights) => void;
}) {
  const id = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Scoring weights</legend>
      {KEYS.map((k) => (
        <div
          key={k}
          className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3"
        >
          <label htmlFor={`${id}-${k}`} className="text-sm">
            {LABEL[k]}
          </label>
          <input
            id={`${id}-${k}`}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(value[k] * 100)}
            onChange={(e) =>
              onChange(rebalance(value, k, Number(e.target.value)))
            }
            aria-valuetext={`${Math.round(value[k] * 100)} percent`}
            className="accent-[var(--tl-warp)]"
          />
          <span className="text-right font-mono text-sm">
            {Math.round(value[k] * 100)}%
          </span>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Weights always sum to 100%. Changing them only rescores — no new Qloo
        data is retrieved.
      </p>
    </fieldset>
  );
}
