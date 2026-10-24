import type { RunEventView } from "./types";

/** Paused (gate) states do not count against the run's wall-clock budget. */
export const isPausedState = (state: string) => state.startsWith("AWAITING_");

export interface StateSpan {
  state: string;
  startMs: number;
  endMs: number;
  paused: boolean;
}

/**
 * State durations for the Gantt view (UI_UX_SPEC §5 full view), from STATE_ENTERED events.
 * The last span ends at `endMs` (the run's finish time, or now while it runs).
 */
export function stateSpans(events: RunEventView[], endMs: number): StateSpan[] {
  const entered = events.filter((e) => e.type === "STATE_ENTERED");
  return entered.map((e, i) => {
    const startMs = Date.parse(e.ts);
    const next = entered[i + 1];
    return {
      state: e.state,
      startMs,
      endMs: Math.max(startMs, next ? Date.parse(next.ts) : endMs),
      paused: isPausedState(e.state),
    };
  });
}

export interface ToolStat {
  method: string;
  calls: number;
  ok: number;
  failed: number;
  results: number;
  origins: Record<string, number>;
}

/** Qloo call statistics from TOOL_CALL_FINISHED payloads (no raw data is ever in events). */
export function toolStats(events: RunEventView[]): ToolStat[] {
  const by = new Map<string, ToolStat>();
  for (const e of events) {
    if (e.type !== "TOOL_CALL_FINISHED") continue;
    const p = e.payload as {
      method?: string;
      outcome?: string;
      resultCount?: number;
      dataOrigin?: string | null;
    };
    const method = p.method ?? "unknown";
    const s = by.get(method) ?? {
      method,
      calls: 0,
      ok: 0,
      failed: 0,
      results: 0,
      origins: {},
    };
    s.calls += 1;
    if (p.outcome === "ERROR") s.failed += 1;
    else s.ok += 1;
    s.results += p.resultCount ?? 0;
    const origin = p.dataOrigin ?? "none";
    s.origins[origin] = (s.origins[origin] ?? 0) + 1;
    by.set(method, s);
  }
  return [...by.values()].sort(
    (a, b) => b.calls - a.calls || a.method.localeCompare(b.method),
  );
}

export interface LlmStat {
  usageComplete: boolean;
  seq: number;
  role: string | null;
  promptId: string;
  modelId: string | null;
  attempts: number;
  fallbackUsed: boolean;
  outputTokens: number;
  costUsd: number;
}

/** One row per LLM step, from LLM_CALL_FINISHED payloads (cost visibility, AM monitor). */
export function llmStats(events: RunEventView[]): LlmStat[] {
  return events
    .filter((e) => e.type === "LLM_CALL_FINISHED")
    .map((e) => {
      const p = e.payload as {
        promptId?: string;
        modelId?: string | null;
        attempts?: number;
        fallbackUsed?: boolean;
        outputTokens?: number;
        costUsd?: number;
        usageComplete?: boolean;
      };
      return {
        seq: e.seq,
        role: e.role,
        promptId: p.promptId ?? "unknown",
        modelId: p.modelId ?? null,
        attempts: p.attempts ?? 1,
        fallbackUsed: !!p.fallbackUsed,
        outputTokens: p.outputTokens ?? 0,
        costUsd: p.costUsd ?? 0,
        usageComplete: p.usageComplete !== false,
      };
    });
}

/** Gaps or duplicates in a received event list (AM-A2: seq must be contiguous). */
export function sequenceGaps(events: RunEventView[]): number[] {
  const seqs = events.map((e) => e.seq);
  const missing: number[] = [];
  for (let i = 1; i < seqs.length; i++)
    for (let s = seqs[i - 1]! + 1; s < seqs[i]!; s++) missing.push(s);
  return missing;
}

export const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
