"use client";

import type { ComparisonMetrics, HypothesisDelta } from "@tessaloom/core";
import { ArrowDown, ArrowRight, ArrowUp, Minus, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ComparisonRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProvenanceChip, StatusPill } from "../provenance";
import { TraceDialog } from "../trace-dialog";
import { Button } from "../ui";

const label = (s: string | null) =>
  s ? s.replace(/_/g, " ").toLowerCase() : "—";
const signed = (v: number | null, digits = 1) =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

function Metric({
  name,
  value,
  hint,
}: {
  name: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <dt className="text-[11px] text-muted-foreground">{name}</dt>
      <dd className="mt-0.5 font-serif text-2xl leading-none">{value}</dd>
      {hint ? (
        <dd className="mt-1 text-[11px] text-muted-foreground">{hint}</dd>
      ) : null}
    </div>
  );
}

function Toggle({
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
    <section
      aria-labelledby={`${id}-t`}
      className="rounded-xl border border-border bg-card p-4"
    >
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
      <p id={`${id}-s`} className="mt-1 text-xs text-muted-foreground">
        {summary}
      </p>
      <div className="mt-3" aria-describedby={`${id}-s`}>
        {asTable ? table : chart}
      </div>
    </section>
  );
}

/** Slope chart of composite scores, parent → branch (shape + label, never color alone). */
function SlopeChart({ rows }: { rows: HypothesisDelta[] }) {
  const pts = rows.filter(
    (r) => r.baseComposite !== null && r.otherComposite !== null,
  );
  const y = (v: number) => 210 - (v / 100) * 190;
  // End labels never overlap: spread them at least 12 px apart, linked to their point.
  const labels = [...pts]
    .map((r) => ({ r, at: y(r.otherComposite!) }))
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++)
    labels[i]!.at = Math.max(labels[i]!.at, labels[i - 1]!.at + 12);
  const height = Math.max(232, (labels.at(-1)?.at ?? 0) + 16);
  return (
    <svg
      viewBox={`0 0 640 ${height}`}
      className="w-full"
      role="img"
      aria-label="Composite score per hypothesis, parent to branch"
    >
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={60} x2={340} y1={y(v)} y2={y(v)} stroke="var(--tl-line)" />
          <text
            x={52}
            y={y(v) + 3}
            textAnchor="end"
            className="fill-[var(--tl-muted)] text-[9px]"
          >
            {v}
          </text>
        </g>
      ))}
      <text x={60} y={226} className="fill-[var(--tl-muted)] text-[10px]">
        Parent
      </text>
      <text
        x={340}
        y={226}
        textAnchor="end"
        className="fill-[var(--tl-muted)] text-[10px]"
      >
        Branch
      </text>
      {pts.map((r) => {
        const up = (r.compositeDelta ?? 0) > 0;
        const down = (r.compositeDelta ?? 0) < 0;
        return (
          <g key={r.lineageId}>
            <line
              x1={60}
              x2={340}
              y1={y(r.baseComposite!)}
              y2={y(r.otherComposite!)}
              stroke={
                up
                  ? "var(--tl-moss)"
                  : down
                    ? "var(--tl-rust)"
                    : "var(--tl-slate)"
              }
              strokeWidth={1.8}
              strokeDasharray={down ? "5 3" : undefined}
            />
            <circle
              cx={60}
              cy={y(r.baseComposite!)}
              r={3}
              fill="var(--tl-ink)"
            />
            <circle
              cx={340}
              cy={y(r.otherComposite!)}
              r={3.5}
              fill="var(--tl-ink)"
            />
          </g>
        );
      })}
      {labels.map(({ r, at }) => (
        <g key={`label-${r.lineageId}`}>
          <line
            x1={344}
            x2={362}
            y1={y(r.otherComposite!)}
            y2={at}
            stroke="var(--tl-line)"
          />
          <text x={366} y={at + 3} className="fill-[var(--tl-ink)] text-[9px]">
            {r.title.length > 44 ? `${r.title.slice(0, 43)}…` : r.title}
          </text>
        </g>
      ))}
    </svg>
  );
}

const STANCES = [
  "SUPPORTS",
  "NEUTRAL",
  "INSUFFICIENT",
  "CONTRADICTS",
  "UNTESTED",
];
const STANCE_FILL: Record<string, string> = {
  SUPPORTS: "var(--tl-moss)",
  NEUTRAL: "var(--tl-slate)",
  INSUFFICIENT: "var(--tl-line)",
  CONTRADICTS: "var(--tl-rust)",
  UNTESTED: "var(--tl-surface-2)",
};

function StanceBars({ m }: { m: ComparisonMetrics }) {
  const rows: [string, Record<string, number>][] = [
    ["Parent", m.stanceDistribution.base],
    ["Branch", m.stanceDistribution.other],
  ];
  return (
    <svg
      viewBox="0 0 520 110"
      className="w-full"
      role="img"
      aria-label="Claim stances, parent and branch"
    >
      {rows.map(([name, dist], i) => {
        const total = Math.max(
          1,
          Object.values(dist).reduce((a, b) => a + b, 0),
        );
        let x = 80;
        return (
          <g key={name}>
            <text
              x={72}
              y={i * 44 + 24}
              textAnchor="end"
              className="fill-[var(--tl-ink)] text-[11px]"
            >
              {name}
            </text>
            {STANCES.filter((s) => dist[s]).map((s) => {
              const w = (dist[s]! / total) * 420;
              const g = (
                <g key={s}>
                  <rect
                    x={x}
                    y={i * 44 + 10}
                    width={w}
                    height={22}
                    fill={STANCE_FILL[s]}
                    stroke="var(--tl-surface)"
                  />
                  {w > 28 ? (
                    <text
                      x={x + w / 2}
                      y={i * 44 + 25}
                      textAnchor="middle"
                      className="fill-[var(--tl-surface)] text-[10px] font-semibold"
                    >
                      {dist[s]}
                    </text>
                  ) : null}
                </g>
              );
              x += w;
              return g;
            })}
          </g>
        );
      })}
      <g>
        {STANCES.map((s, i) => (
          <g key={s} transform={`translate(${80 + i * 88}, 98)`}>
            <rect
              width={10}
              height={10}
              y={-9}
              fill={STANCE_FILL[s]}
              stroke="var(--tl-line)"
            />
            <text x={14} className="fill-[var(--tl-muted)] text-[10px]">
              {label(s)}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function RankShift({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  if (v === 0)
    return (
      <span className="inline-flex items-center gap-1">
        <Minus aria-hidden className="size-3" /> same rank
      </span>
    );
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        v > 0 ? "text-moss" : "text-rust",
      )}
    >
      {v > 0 ? (
        <ArrowUp aria-hidden className="size-3" />
      ) : (
        <ArrowDown aria-hidden className="size-3" />
      )}
      {v > 0 ? `up ${v}` : `down ${-v}`}
    </span>
  );
}

type SortKey = "composite" | "rank" | "title";

/**
 * Comparison view (UI_UX_SPEC §4.5): genuineness header, narrative, hypothesis deltas, charts
 * with table views, per-query diffs, and claim stance changes. All numbers come from the
 * deterministic metrics; the narrative is labeled by who wrote it.
 */
export function ComparisonView({
  comparison,
  names,
}: {
  comparison: ComparisonRow;
  names: Map<string, string>;
}) {
  const m = comparison.metrics;
  const [sort, setSort] = useState<SortKey>("composite");
  const [trace, setTrace] = useState<string | null>(null);
  const rows = useMemo(() => {
    const r = [...m.perHypothesis];
    if (sort === "composite")
      r.sort(
        (a, b) =>
          Math.abs(b.compositeDelta ?? 0) - Math.abs(a.compositeDelta ?? 0),
      );
    if (sort === "rank")
      r.sort((a, b) => (b.rankShift ?? 0) - (a.rankShift ?? 0));
    if (sort === "title") r.sort((a, b) => a.title.localeCompare(b.title));
    return r;
  }, [m.perHypothesis, sort]);
  const name = (id: string) => names.get(id) ?? id;
  const changedClaims = m.perClaim.filter((c) => c.changed);

  return (
    <div className="space-y-5" data-testid="comparison-view">
      {m.header.rescoreOnly ? (
        <p
          className="rounded-lg border-2 border-dashed border-slate bg-surface-2 px-4 py-2.5 text-sm font-medium"
          data-testid="rescore-label"
        >
          Rescored with existing evidence — no new Qloo data was retrieved.
        </p>
      ) : null}
      <dl
        className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6"
        data-testid="comparison-header"
      >
        <Metric
          name="Queries re-run"
          value={String(m.header.dirtyQueries)}
          hint="dirty"
        />
        <Metric
          name="Queries reused"
          value={String(m.header.reusedQueries)}
          hint="unchanged evidence"
        />
        <Metric
          name="New Qloo results"
          value={String(m.header.newQlooResults)}
        />
        <Metric
          name="Drift index"
          value={
            m.header.driftIndex === null ? "—" : m.header.driftIndex.toFixed(2)
          }
          hint="0 = same results"
        />
        <Metric
          name="Claims changed stance"
          value={String(m.header.changedStances)}
        />
        <Metric
          name="Hypotheses changed status"
          value={String(m.header.changedStatuses)}
        />
      </dl>

      {comparison.narrative ? (
        <section
          aria-labelledby="narrative-h"
          className="rounded-xl border border-border bg-card p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="narrative-h" className="font-semibold">
              What changed
            </h3>
            <ProvenanceChip provenance={comparison.narrative.provenance} />
          </div>
          <p className="mt-2 text-sm leading-relaxed" data-testid="narrative">
            {comparison.narrative.rendered}
          </p>
          {comparison.narrative.citedEvidenceIds.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Cites</span>
              {comparison.narrative.citedEvidenceIds.map((id, i) => (
                <Button
                  key={id}
                  variant="secondary"
                  size="sm"
                  onClick={() => setTrace(id)}
                >
                  <Search aria-hidden className="size-3" /> E-{i + 1}
                </Button>
              ))}
            </div>
          ) : null}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Every number above is rendered from the computed metrics.
          </p>
        </section>
      ) : null}

      <section
        aria-labelledby="delta-h"
        className="rounded-xl border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="delta-h" className="font-semibold">
            Hypotheses, parent → branch
          </h3>
          <label className="flex items-center gap-1.5 text-xs">
            Sort by
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded border border-border bg-surface px-1.5 py-1"
            >
              <option value="composite">largest score change</option>
              <option value="rank">rank shift</option>
              <option value="title">title</option>
            </select>
          </label>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table
            className="w-full min-w-[560px] text-left text-sm"
            data-testid="hypothesis-deltas"
          >
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 font-medium">Hypothesis</th>
                <th className="py-1.5 font-medium">Status</th>
                <th className="py-1.5 font-medium">Composite</th>
                <th className="py-1.5 font-medium">Rank</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr
                  key={h.lineageId}
                  className="border-t border-border align-top"
                >
                  <td className="py-2 pr-3 font-serif">{h.title}</td>
                  <td className="py-2 pr-3">
                    {h.statusChanged ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusPill status={h.baseStatus ?? ""} />
                        <ArrowRight aria-label="to" className="size-3.5" />
                        <StatusPill status={h.otherStatus ?? ""} />
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        unchanged ({label(h.otherStatus)})
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {h.baseComposite?.toFixed(1) ?? "—"} →{" "}
                    {h.otherComposite?.toFixed(1) ?? "—"}{" "}
                    <span
                      className={cn(
                        (h.compositeDelta ?? 0) > 0 && "text-moss",
                        (h.compositeDelta ?? 0) < 0 && "text-rust",
                      )}
                    >
                      ({signed(h.compositeDelta)})
                    </span>
                  </td>
                  <td className="py-2 text-xs">
                    <RankShift v={h.rankShift} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 2xl:grid-cols-2">
        <Toggle
          title="Composite scores"
          summary={`${rows.filter((r) => (r.compositeDelta ?? 0) > 0).length} rose, ${rows.filter((r) => (r.compositeDelta ?? 0) < 0).length} fell (dashed), ${rows.filter((r) => r.compositeDelta === 0).length} unchanged.`}
          chart={<SlopeChart rows={rows} />}
          table={
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Hypothesis</th>
                  <th className="py-1 font-medium">Parent</th>
                  <th className="py-1 font-medium">Branch</th>
                  <th className="py-1 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lineageId} className="border-t border-border">
                    <td className="py-1">{r.title}</td>
                    <td className="py-1 font-mono">
                      {r.baseComposite?.toFixed(1) ?? "—"}
                    </td>
                    <td className="py-1 font-mono">
                      {r.otherComposite?.toFixed(1) ?? "—"}
                    </td>
                    <td className="py-1 font-mono">
                      {signed(r.compositeDelta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
        <Toggle
          title="Claim stances"
          summary={`${m.header.changedStances} of ${m.perClaim.length} claims changed stance.`}
          chart={<StanceBars m={m} />}
          table={
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Stance</th>
                  <th className="py-1 font-medium">Parent</th>
                  <th className="py-1 font-medium">Branch</th>
                </tr>
              </thead>
              <tbody>
                {STANCES.map((s) => (
                  <tr key={s} className="border-t border-border">
                    <td className="py-1">{label(s)}</td>
                    <td className="py-1 font-mono">
                      {m.stanceDistribution.base[s] ?? 0}
                    </td>
                    <td className="py-1 font-mono">
                      {m.stanceDistribution.other[s] ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      </div>

      {changedClaims.length ? (
        <section
          aria-labelledby="claims-h"
          className="rounded-xl border border-border bg-card p-4"
        >
          <h3 id="claims-h" className="font-semibold">
            Claims that changed stance
          </h3>
          <ul className="mt-2 space-y-2 text-sm" data-testid="stance-changes">
            {changedClaims.map((c) => (
              <li
                key={`${c.lineageId}-${c.ordinal}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-0 flex-1">
                  {c.statement}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({c.hypothesisTitle})
                  </span>
                </span>
                {c.baseStance ? (
                  <StatusPill status={c.baseStance} />
                ) : (
                  <span className="text-xs">untested</span>
                )}
                <ArrowRight aria-label="to" className="size-3.5" />
                {c.otherStance ? (
                  <StatusPill status={c.otherStance} />
                ) : (
                  <span className="text-xs">untested</span>
                )}
                {c.otherEvidenceId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTrace(c.otherEvidenceId)}
                  >
                    <Search aria-hidden className="size-3" /> Trace
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {m.perQuery.length ? (
        <section
          aria-labelledby="queries-h"
          className="rounded-xl border border-border bg-card p-4"
        >
          <h3 id="queries-h" className="font-semibold">
            Re-run queries, side by side
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Top results before and after; ＋ entered, − exited. Overlap is the
            share of shared results; RBO weights the top ranks more.
          </p>
          <ul className="mt-3 space-y-4" data-testid="query-diffs">
            {m.perQuery.map((q) => (
              <li key={q.key} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">
                  {q.kind === "discovery" ? "Discovery" : "Claim query"}:{" "}
                  {q.label}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                  <span className="flex items-center gap-2">
                    Overlap
                    <span
                      className="inline-block h-1.5 w-24 rounded-full bg-surface-2"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-warp"
                        style={{ width: `${Math.round(q.overlapAtK * 100)}%` }}
                      />
                    </span>
                    <span className="font-mono">{q.overlapAtK.toFixed(2)}</span>
                  </span>
                  <span>
                    RBO <span className="font-mono">{q.rbo.toFixed(2)}</span>
                  </span>
                </div>
                <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                  <div>
                    <p className="font-semibold text-moss">
                      ＋ Entered ({q.entered.length})
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {q.entered.slice(0, 8).map(name).join(", ") || "none"}
                      {q.entered.length > 8
                        ? ` … and ${q.entered.length - 8} more`
                        : ""}
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-rust">
                      − Exited ({q.exited.length})
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {q.exited.slice(0, 8).map(name).join(", ") || "none"}
                      {q.exited.length > 8
                        ? ` … and ${q.exited.length - 8} more`
                        : ""}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {trace ? (
        <TraceDialog evidenceId={trace} onClose={() => setTrace(null)} />
      ) : null}
    </div>
  );
}
