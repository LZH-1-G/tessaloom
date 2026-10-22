"use client";

import {
  Activity,
  ChevronDown,
  CircleAlert,
  Maximize2,
  Radio,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { stateSpans } from "@/lib/activity";
import { api } from "@/lib/api";
import type { RunEventView, RunView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityFull } from "./activity-full";
import { Button } from "./ui";

const PAUSED = (state: string) => state.startsWith("AWAITING_");
const TERMINAL = ["COMPLETED", "COMPLETED_WITH_LIMITS", "FAILED", "CANCELLED"];
const label = (state: string) => state.replace(/_/g, " ").toLowerCase();

const GATE_COPY: Record<string, { text: string; page: string }> = {
  BRIEF: { text: "Confirm how the agent read your brief.", page: "brief" },
  ENTITIES: {
    text: "Choose which Qloo entities you meant.",
    page: "discovery",
  },
  POOL: {
    text: "Review the collision pool and its tension.",
    page: "discovery",
  },
  HYPOTHESIS_SELECTION: {
    text: "Select hypotheses to carry forward.",
    page: "hypotheses",
  },
  COUNTERFACTUAL_COST: {
    text: "Approve the Qloo calls this what-if needs.",
    page: "what-if",
  },
};

/** Live run stream: SSE with resume (`?after=`), closed while paused or finished (API_CONTRACTS §10). */
export function useRunEvents(run: RunView | null, onChange: () => void) {
  const [store, setStore] = useState<{
    runId: string | null;
    events: RunEventView[];
  }>({ runId: null, events: [] });
  const [live, setLive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const lastSeq = useRef<{ runId: string | null; seq: number }>({
    runId: null,
    seq: 0,
  });
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  const runId = run?.id ?? null;
  // Reconnect only when the run becomes runnable again (a new job was enqueued).
  const phase =
    run && (PAUSED(run.state) || TERMINAL.includes(run.state))
      ? `rest:${run.state}`
      : "active";

  useEffect(() => {
    if (!runId) return;
    if (lastSeq.current.runId !== runId) lastSeq.current = { runId, seq: 0 };
    const source = new EventSource(
      `/api/v1/runs/${runId}/events?after=${lastSeq.current.seq}`,
    );
    source.onopen = () => {
      setLive(true);
      setReconnecting(false);
    };
    source.addEventListener("run-event", (message) => {
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as RunEventView;
      if (event.seq <= lastSeq.current.seq) return; // never duplicate after a reconnect
      lastSeq.current = { runId, seq: event.seq };
      setStore((prev) =>
        prev.runId === runId
          ? { runId, events: [...prev.events, event] }
          : { runId, events: [event] },
      );
      if (
        [
          "STATE_ENTERED",
          "CONFIRMATION_REQUESTED",
          "RUN_COMPLETED",
          "RUN_FAILED",
          "RUN_CANCELLED",
          "BUDGET_UPDATED",
        ].includes(event.type)
      )
        changeRef.current();
    });
    source.addEventListener("run-terminal", () => {
      source.close();
      setLive(false);
      setReconnecting(false);
      changeRef.current();
    });
    // EventSource retries on its own and resumes with Last-Event-ID (no gaps, no duplicates).
    source.onerror = () => {
      setLive(false);
      setReconnecting(source.readyState === EventSource.CONNECTING);
    };
    return () => source.close();
  }, [runId, phase]);

  const events = store.runId === runId ? store.events : [];
  return { events, live, reconnecting };
}

/** Wall clock that ticks once per second while mounted (keeps renders pure). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Meter({
  name,
  used,
  max,
  format = (v: number) => String(v),
}: {
  name: string;
  used: number;
  max: number;
  format?: (v: number) => string;
}) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{name}</span>
        <span className="font-mono">
          {format(used)} / {format(max)}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
      >
        <div
          className={cn(
            "h-full rounded-full",
            ratio >= 0.8 ? "bg-saffron" : "bg-warp",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

const ICON: Record<string, string> = {
  STATE_ENTERED: "→",
  DECISION_SUMMARY: "✎",
  TOOL_CALL_FINISHED: "⌁",
  LLM_CALL_FINISHED: "◇",
  VALIDATION_PASSED: "✓",
  VALIDATION_FAILED: "!",
  REPAIR_ATTEMPTED: "↺",
  BUDGET_UPDATED: "▤",
  BUDGET_EXHAUSTED: "▤",
  CONFIRMATION_REQUESTED: "?",
  CONFIRMATION_RECEIVED: "✓",
  RUN_STARTED: "▶",
  RUN_COMPLETED: "■",
  RUN_FAILED: "✕",
  RUN_CANCELLED: "■",
  CANCEL_REQUESTED: "■",
};

export function ActivityDock({
  run,
  projectId,
  onChange,
}: {
  run: RunView | null;
  projectId: string;
  onChange: () => void;
}) {
  const { events, live, reconnecting } = useRunEvents(run, onChange);
  const [full, setFull] = useState(false);
  const now = useNow();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pending = run?.pendingConfirmation;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [events.length]);
  useEffect(() => {
    const base = document.title.replace(/^• /, "");
    document.title = run && PAUSED(run.state) ? `• ${base}` : base;
  }, [run?.state, run]);

  const groups = useMemo(() => {
    const out: { state: string; items: RunEventView[] }[] = [];
    for (const e of events) {
      if (e.type === "STATE_ENTERED" || !out.length)
        out.push({ state: e.state, items: [] });
      out[out.length - 1]!.items.push(e);
    }
    return out;
  }, [events]);

  if (!run)
    return (
      <aside
        aria-label="Decisions and actions"
        className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground"
      >
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Activity aria-hidden className="size-4" /> Decisions &amp; actions
        </p>
        <p className="mt-2">No run yet. Interpreting a brief starts one.</p>
      </aside>
    );

  // The wall-clock budget charges working time only; time waiting at a gate is excluded.
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const spans = stateSpans(events, endMs);
  const elapsed = spans.length
    ? spans
        .filter((sp) => !sp.paused && !TERMINAL.includes(sp.state))
        .reduce((n, sp) => n + (sp.endMs - sp.startMs), 0) / 1000
    : 0;
  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/api/v1/runs/${run.id}/cancel`);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const gate = pending ? GATE_COPY[pending.kind] : undefined;

  return (
    <aside
      aria-label="Decisions and actions"
      className="flex max-h-[calc(100vh-7rem)] flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Activity aria-hidden className="size-4" /> Decisions &amp; actions
            {live ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-moss/10 px-1.5 text-[10px] font-semibold uppercase text-moss">
                <Radio
                  aria-hidden
                  className="size-3 motion-safe:animate-pulse"
                />{" "}
                Live
              </span>
            ) : reconnecting ? (
              <span
                role="status"
                className="rounded-full bg-saffron-tint px-1.5 text-[10px] font-semibold uppercase"
              >
                Reconnecting…
              </span>
            ) : null}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-[11px] uppercase text-muted-foreground"
            aria-live="polite"
            data-testid="run-state"
          >
            {label(run.state)}
            {run.kind === "EXPLORATION" && !TERMINAL.includes(run.state)
              ? ` · iteration ${run.iteration + 1}/${run.budget.maxIterations}`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {!TERMINAL.includes(run.state) ? (
            <Button
              variant="danger"
              size="sm"
              onClick={cancel}
              disabled={busy || run.cancelRequested}
            >
              <X aria-hidden className="size-3.5" />{" "}
              {run.cancelRequested ? "Cancelling" : "Cancel"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Open the full activity view"
            onClick={() => setFull(true)}
          >
            <Maximize2 aria-hidden className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={open ? "Collapse activity" : "Expand activity"}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 transition-transform",
                !open && "-rotate-90",
              )}
            />
          </Button>
        </div>
      </div>
      {open ? (
        <>
          {gate ? (
            <div
              className="m-3 rounded-md border-2 border-saffron bg-saffron-tint p-3 text-sm"
              role="status"
            >
              <p className="flex items-center gap-1.5 font-semibold">
                <CircleAlert aria-hidden className="size-4" /> Needs your input
              </p>
              <p className="mt-1">{gate.text}</p>
              <Link
                href={`/projects/${projectId}/${gate.page}`}
                className="mt-2 inline-block font-medium text-warp underline underline-offset-2"
              >
                Open the {gate.page} page
              </Link>
            </div>
          ) : null}
          {run.state === "FAILED" ? (
            <div
              className="m-3 rounded-md border border-rust/60 bg-rust/5 p-3 text-sm"
              role="alert"
            >
              <p className="font-semibold text-rust">
                The run stopped:{" "}
                {run.terminalReason?.replace(/_/g, " ").toLowerCase()}
              </p>
              <p className="mt-1 text-muted-foreground">
                Your data so far is saved.
              </p>
              {["LLM_UNAVAILABLE", "STEP_RETRIES_EXHAUSTED"].includes(
                run.terminalReason ?? "",
              ) ? (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    void api.post(`/api/v1/runs/${run.id}/retry`).then(onChange)
                  }
                >
                  Retry step
                </Button>
              ) : null}
            </div>
          ) : null}
          {run.state === "CANCELLED" ? (
            <p className="m-3 rounded-md border border-border p-3 text-sm">
              Run cancelled — evidence incomplete.
            </p>
          ) : null}
          {run.state === "COMPLETED_WITH_LIMITS" ? (
            <p className="m-3 rounded-md border border-saffron p-3 text-sm">
              Stopped at a budget limit (
              {run.terminalReason?.replace("BUDGET:", "")}). Results so far are
              shown; untested claims are marked.
            </p>
          ) : null}
          <div className="space-y-2 border-b border-border px-4 py-3">
            <Meter
              name="Qloo calls"
              used={run.usage.qlooCalls}
              max={run.budget.maxQlooCalls}
            />
            <Meter
              name="LLM calls"
              used={run.usage.llmCalls}
              max={run.budget.maxLlmCalls}
            />
            <Meter
              name="Est. cost"
              used={run.usage.estimatedCostUsd}
              max={run.budget.maxEstimatedCostUsd}
              format={(v) => `$${v.toFixed(2)}`}
            />
            <Meter
              name="Active time"
              used={Math.round(elapsed)}
              max={run.budget.wallClockSeconds}
              format={(v) =>
                `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`
              }
            />
          </div>
          <ol
            ref={listRef}
            className="min-h-24 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm"
            aria-label="Run timeline"
          >
            {groups.map((g, gi) => (
              <li key={`${g.state}-${gi}`}>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {label(g.state)}
                </p>
                <ul className="space-y-1">
                  {g.items.map((e) => (
                    <li key={e.seq} data-seq={e.seq} className="flex gap-2">
                      <span
                        aria-hidden
                        className="w-4 shrink-0 text-center font-mono text-muted-foreground"
                      >
                        {ICON[e.type] ?? "·"}
                      </span>
                      <div className="min-w-0">
                        {e.type === "TOOL_CALL_FINISHED" ? (
                          <button
                            type="button"
                            className="text-left hover:underline"
                            aria-expanded={expanded === e.seq}
                            onClick={() =>
                              setExpanded(expanded === e.seq ? null : e.seq)
                            }
                          >
                            {e.summary}
                          </button>
                        ) : (
                          <span>{e.summary}</span>
                        )}
                        {expanded === e.seq ? (
                          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded bg-surface-2 p-2 font-mono text-[11px]">
                            {Object.entries(e.payload).map(([k, v]) => (
                              <div key={k} className="contents">
                                <dt className="text-muted-foreground">{k}</dt>
                                <dd className="truncate">{String(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {full ? (
        <ActivityFull
          run={run}
          events={events}
          now={now}
          onClose={() => setFull(false)}
        />
      ) : null}
    </aside>
  );
}
