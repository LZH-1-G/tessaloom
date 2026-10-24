"use client";

import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  formatDuration,
  llmStats,
  sequenceGaps,
  stateSpans,
  toolStats,
} from "@/lib/activity";
import type { RunEventView, RunView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** "View as table" toggle shared by every chart (UI_UX_SPEC §8 Charts). */
function ChartOrTable({
  title,
  summary,
  chart,
  table,
}: {
  title: string;
  summary: string;
  chart: React.ReactNode;
  table: React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-t`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${id}-t`} className="font-semibold">
          {title}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? "View as chart" : "View as table"}
        </Button>
      </div>
      <p id={`${id}-s`} className="text-xs text-muted-foreground">
        {summary}
      </p>
      <div aria-describedby={`${id}-s`}>{asTable ? table : chart}</div>
    </section>
  );
}

/**
 * Activity Monitor full view (UI_UX_SPEC §5): the complete timeline, a state-duration chart,
 * Qloo call statistics, and LLM cost per step. Decisions and actions only — the monitor never
 * shows model reasoning.
 */
export function ActivityFull({
  run,
  events,
  now,
  onClose,
}: {
  run: RunView;
  events: RunEventView[];
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState("all");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const spans = useMemo(() => stateSpans(events, endMs), [events, endMs]);
  const tools = useMemo(() => toolStats(events), [events]);
  const llm = useMemo(() => llmStats(events), [events]);
  const gaps = useMemo(() => sequenceGaps(events), [events]);
  const types = [...new Set(events.map((e) => e.type))].sort();
  const shown = type === "all" ? events : events.filter((e) => e.type === type);
  const t0 = spans[0]?.startMs ?? endMs;
  const total = Math.max(1, endMs - t0);
  const activeMs = spans
    .filter((s) => !s.paused)
    .reduce((n, s) => n + (s.endMs - s.startMs), 0);
  const totalCost = llm.reduce((n, l) => n + l.costUsd, 0);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="activity-full-title"
      className="m-auto h-[min(860px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h2 id="activity-full-title" className="font-serif text-xl">
            Decisions &amp; actions — full view
          </h2>
          <p className="text-xs text-muted-foreground">
            {run.kind.toLowerCase()} run · {label(run.state)} · {events.length}{" "}
            events
            {gaps.length
              ? ` · ${gaps.length} missing (reconnecting fills them)`
              : " · complete and in order"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close full view"
          onClick={() => ref.current?.close()}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-reachable
        tabIndex={0}
        role="region"
        aria-label="Activity details"
        className="grid h-[calc(100%-4.25rem)] gap-6 overflow-y-auto px-5 py-4 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        <div className="space-y-6">
          <dl
            className="grid grid-cols-2 gap-3 sm:grid-cols-4"
            data-testid="activity-totals"
          >
            {[
              [
                "Qloo calls",
                `${run.usage.qlooCalls} / ${run.budget.maxQlooCalls}`,
              ],
              [
                "LLM calls",
                `${run.usage.llmCalls} / ${run.budget.maxLlmCalls}`,
              ],
              [
                "Est. cost",
                `$${run.usage.estimatedCostUsd.toFixed(4)} / $${run.budget.maxEstimatedCostUsd.toFixed(2)}`,
              ],
              ["Active time", formatDuration(activeMs)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border p-2.5">
                <dt className="text-[11px] text-muted-foreground">{k}</dt>
                <dd className="font-mono text-sm">{v}</dd>
              </div>
            ))}
          </dl>
          <ChartOrTable
            title="Time in each state"
            summary={`${spans.length} state changes over ${formatDuration(total)}; ${formatDuration(activeMs)} active, the rest waiting for you at gates (not charged to the time budget).`}
            chart={
              <svg
                role="img"
                aria-label="State duration chart"
                viewBox={`0 0 600 ${spans.length * 22 + 8}`}
                className="w-full"
              >
                {spans.map((s, i) => {
                  const x = ((s.startMs - t0) / total) * 400 + 190;
                  const w = Math.max(2, ((s.endMs - s.startMs) / total) * 400);
                  return (
                    <g key={`${s.state}-${i}`}>
                      <text
                        x={182}
                        y={i * 22 + 18}
                        textAnchor="end"
                        className="fill-[var(--tl-muted)] text-[10px]"
                      >
                        {label(s.state)}
                      </text>
                      <rect
                        x={x}
                        y={i * 22 + 7}
                        width={w}
                        height={14}
                        rx={2}
                        className={
                          s.paused
                            ? "fill-[var(--tl-saffron-tint)] stroke-[var(--tl-saffron)]"
                            : "fill-[var(--tl-warp)]"
                        }
                        strokeDasharray={s.paused ? "3 2" : undefined}
                      />
                    </g>
                  );
                })}
              </svg>
            }
            table={
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">State</th>
                    <th className="py-1 font-medium">Duration</th>
                    <th className="py-1 font-medium">Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {spans.map((s, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-1">{label(s.state)}</td>
                      <td className="py-1 font-mono">
                        {formatDuration(s.endMs - s.startMs)}
                      </td>
                      <td className="py-1">
                        {s.paused ? "waiting for you" : "working"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          />
          <section aria-labelledby="tool-stats" className="space-y-2">
            <h3 id="tool-stats" className="font-semibold">
              Qloo calls by workflow
            </h3>
            <table
              className="w-full text-left text-xs"
              data-testid="tool-stats"
            >
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Workflow</th>
                  <th className="py-1 font-medium">Calls</th>
                  <th className="py-1 font-medium">Failed</th>
                  <th className="py-1 font-medium">Results</th>
                  <th className="py-1 font-medium">Data origin</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.method} className="border-t border-border">
                    <td className="py-1 font-mono">{t.method}</td>
                    <td className="py-1">{t.calls}</td>
                    <td className="py-1">{t.failed}</td>
                    <td className="py-1">{t.results}</td>
                    <td className="py-1">
                      {Object.entries(t.origins)
                        .map(
                          ([o, n]) =>
                            `${o === "FIXTURE" ? "fixture (not Qloo data)" : o.toLowerCase()} ×${n}`,
                        )
                        .join(", ")}
                    </td>
                  </tr>
                ))}
                {!tools.length ? (
                  <tr>
                    <td colSpan={5} className="py-2 text-muted-foreground">
                      No Qloo calls in this run.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="llm-stats" className="space-y-2">
            <h3 id="llm-stats" className="font-semibold">
              AI steps and cost
            </h3>
            <table className="w-full text-left text-xs" data-testid="llm-stats">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Step</th>
                  <th className="py-1 font-medium">Model</th>
                  <th className="py-1 font-medium">Attempts</th>
                  <th className="py-1 font-medium">Output tokens</th>
                  <th className="py-1 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {llm.map((l) => (
                  <tr key={l.seq} className="border-t border-border">
                    <td className="py-1">
                      {l.role} · <span className="font-mono">{l.promptId}</span>
                    </td>
                    <td className="py-1 font-mono">
                      {l.modelId ?? "—"}
                      {l.fallbackUsed ? " (fallback)" : ""}
                    </td>
                    <td className="py-1">{l.attempts}</td>
                    <td className="py-1">
                      {l.usageComplete ? l.outputTokens : "Unavailable"}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {l.usageComplete ? `$${l.costUsd.toFixed(4)}` : "Unknown"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border font-semibold">
                  <td className="py-1" colSpan={4}>
                    {llm.some((l) => !l.usageComplete)
                      ? "Known subtotal"
                      : "Total"}
                  </td>
                  <td className="py-1 text-right font-mono">
                    ${totalCost.toFixed(4)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground">
              Costs are estimates. Scripted models and confirmed free-tier calls
              report $0. Missing provider usage is unknown; its spending
              reservation remains held.
            </p>
          </section>
        </div>
        <section aria-labelledby="full-timeline" className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id="full-timeline" className="font-semibold">
              Timeline
            </h3>
            <label className="flex items-center gap-1.5 text-xs">
              Show
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="rounded border border-border bg-surface px-1.5 py-1"
              >
                <option value="all">all events</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ol className="space-y-1 text-xs" data-testid="full-timeline">
            {shown.map((e) => (
              <li
                key={e.seq}
                data-seq={e.seq}
                className={cn(
                  "grid grid-cols-[3rem_1fr] gap-2 rounded px-1.5 py-1 [content-visibility:auto]",
                  e.type === "STATE_ENTERED" && "bg-surface-2",
                )}
              >
                <span className="font-mono text-muted-foreground">
                  #{e.seq}
                </span>
                <span>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">
                    {label(e.type)}
                  </span>{" "}
                  {e.summary}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </dialog>
  );
}
