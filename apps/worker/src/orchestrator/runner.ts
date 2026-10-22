import {
  IllegalTransition,
  addUsage,
  exhaustedLimit,
  executeStep,
  isPaused,
  isRunnable,
  isTerminal,
  nextState,
  stateNeeds,
  type Ports,
  type StepResult,
} from "@tessaloom/agent";
import type { RunState } from "@tessaloom/core";
import {
  appendRunEvents,
  enqueueRunStep,
  getRun,
  blueprintForRun,
  loadRunSnapshot,
  lockRunAtVersion,
  setExperimentStatus,
  transitionRun,
  withPgTx,
  type DbHandle,
  type NewRunEvent,
  type PgBoss,
  type RunStepJob,
} from "@tessaloom/db";
import { applyCommit } from "./commit";
import { buildStepContext, enrichCounterfactualContext } from "./context";

export interface RunnerDeps {
  handle: DbHandle;
  boss: PgBoss;
  ports: Ports;
  now?: () => Date;
  log?: (event: string, details: Record<string, unknown>) => void;
  cancelPollMs?: number;
  /** Test-only fault injection between the external calls and the commit. */
  hooks?: {
    beforeCommit?: (runId: string, state: RunState) => void | Promise<void>;
  };
}

export interface Attempt {
  retryCount: number;
  retryLimit: number;
}

export type StepOutcome =
  | { outcome: "skipped" | "stale"; state?: RunState }
  | { outcome: "committed"; from: RunState; to: RunState };

/** Thrown to make pg-boss retry the job (transient failure with retries left). */
export class RetryStep extends Error {}

const summarize = (s: string) => (s.length <= 280 ? s : `${s.slice(0, 279)}…`);

function experimentStatusFor(state: RunState) {
  if (isTerminal(state))
    return state as
      "COMPLETED" | "COMPLETED_WITH_LIMITS" | "FAILED" | "CANCELLED";
  return isPaused(state) ? "PAUSED" : "RUNNING";
}

const plain = (reason: string): StepResult => ({
  event: "FATAL_ERROR",
  guard: {},
  commit: {},
  events: [],
  usage: {},
  terminalReason: reason,
  error: { code: reason, message: reason },
});

/** AGENT_WORKFLOW §6.2 handleRunStep. Exactly one commit per state version. */
export async function runStep(
  deps: RunnerDeps,
  job: RunStepJob,
  attempt: Attempt,
): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.handle;
  const run = await getRun(db, job.runId).catch(() => null);
  if (!run) return { outcome: "skipped" };
  if (run.stateVersion !== job.expectedStateVersion)
    return { outcome: "stale", state: run.state };
  if (!isRunnable(run.state)) return { outcome: "skipped", state: run.state };

  const snap = await loadRunSnapshot(db, run.id);
  if (!snap) return { outcome: "skipped" };
  const controller = new AbortController();
  const ctx = buildStepContext(snap, now(), controller.signal);
  await enrichCounterfactualContext(db, ctx);
  if (ctx.run.kind === "COMPOSITION" && snap.run.blueprintId)
    ctx.blueprint = await blueprintForRun(db, snap.run.blueprintId);

  let result: StepResult;
  if (run.cancelRequestedAt) {
    result = { ...plain("USER_CANCELLED"), event: "CANCEL", error: null };
  } else {
    const limit = exhaustedLimit(
      ctx.run.budget,
      ctx.run.usage,
      ctx.run.elapsedSeconds,
      stateNeeds(run.state),
    );
    if (limit) {
      result = {
        ...plain(`BUDGET:${limit}`),
        event: "BUDGET_EXHAUSTED",
        guard: { outputsConsistent: true },
        error: null,
      };
    } else {
      // Poll the cancel flag while external calls run; in-flight calls are aborted.
      const poll = setInterval(() => {
        getRun(db, run.id)
          .then((r) => {
            if (r.cancelRequestedAt) controller.abort();
          })
          .catch(() => {});
      }, deps.cancelPollMs ?? 1000);
      try {
        result = await executeStep(ctx, deps.ports);
      } catch (error) {
        deps.log?.("run_step_error", {
          runId: run.id,
          state: run.state,
          name: (error as Error).name,
        });
        if (attempt.retryCount < attempt.retryLimit) throw error;
        result = plain("STEP_RETRIES_EXHAUSTED");
      } finally {
        clearInterval(poll);
      }
      if (result.transient && attempt.retryCount < attempt.retryLimit)
        throw new RetryStep(result.terminalReason ?? "transient");
    }
  }

  // Checked again before commit: a cancel wins over the step's own transition.
  if (result.event !== "CANCEL") {
    const latest = await getRun(db, run.id);
    if (latest.cancelRequestedAt)
      result = {
        ...result,
        event: "CANCEL",
        terminalReason: "USER_CANCELLED",
        error: null,
      };
  }

  let to: RunState;
  try {
    to = nextState(run.state, result.event, {
      ...result.guard,
      kind: run.kind,
    });
  } catch (error) {
    if (!(error instanceof IllegalTransition)) throw error;
    deps.log?.("run_illegal_transition", {
      runId: run.id,
      from: run.state,
      event: result.event,
      reason: error.reason,
    });
    result = {
      ...plain("ILLEGAL_TRANSITION"),
      events: result.events,
      usage: result.usage,
    };
    to = "FAILED";
  }

  await deps.hooks?.beforeCommit?.(run.id, run.state);

  const usage = addUsage(ctx.run.usage, result.usage);
  const events: NewRunEvent[] = result.events.map((e) => ({
    type: e.type,
    state: run.state,
    role: e.role ?? null,
    summary: summarize(e.summary),
    payload: e.payload,
  }));
  const used = Object.values(result.usage).some((v) => (v ?? 0) !== 0);
  if (used)
    events.push({
      type: "BUDGET_UPDATED",
      state: run.state,
      summary: summarize(
        `Budget: ${usage.qlooCalls}/${ctx.run.budget.maxQlooCalls} Qloo calls, ${usage.llmCalls}/${ctx.run.budget.maxLlmCalls} LLM calls, $${usage.estimatedCostUsd.toFixed(4)}/$${ctx.run.budget.maxEstimatedCostUsd.toFixed(2)}`,
      ),
      payload: { usage, budget: ctx.run.budget },
    });
  if (result.event === "BUDGET_EXHAUSTED")
    events.push({
      type: "BUDGET_EXHAUSTED",
      state: run.state,
      summary: summarize(
        `Stopped at a budget limit (${result.terminalReason}); results so far are kept`,
      ),
      payload: { limit: result.terminalReason },
    });
  events.push({
    type: "STATE_ENTERED",
    state: to,
    summary: `Entered ${to}`,
    payload: { from: run.state, event: result.event },
  });
  const pending = isPaused(to) ? (result.pendingConfirmation ?? null) : null;
  if (pending)
    events.push({
      type: "CONFIRMATION_REQUESTED",
      state: to,
      summary: summarize(
        `Waiting for your confirmation (${String(pending.kind)})`,
      ),
      payload: pending,
    });
  if (isTerminal(to))
    events.push({
      type:
        to === "FAILED"
          ? "RUN_FAILED"
          : to === "CANCELLED"
            ? "RUN_CANCELLED"
            : "RUN_COMPLETED",
      state: to,
      summary: summarize(
        to === "FAILED"
          ? `Run failed: ${result.error?.message ?? result.terminalReason ?? "unknown error"}`
          : to === "CANCELLED"
            ? "Run cancelled — evidence incomplete"
            : to === "COMPLETED_WITH_LIMITS"
              ? `Run completed with limits (${result.terminalReason})`
              : "Run completed",
      ),
      payload: { terminalReason: result.terminalReason ?? null },
    });

  const committed = await withPgTx(deps.handle, async (tx, raw) => {
    const locked = await lockRunAtVersion(tx, run.id, job.expectedStateVersion);
    if (!locked) return false; // another commit won; this job is stale
    await applyCommit(
      tx,
      {
        experimentId: snap.experiment.id,
        projectId: snap.experiment.projectId,
        workspaceId: snap.workspaceId,
        runId: run.id,
        briefVersionId: snap.experiment.briefVersionId,
        blueprintId: snap.run.blueprintId,
      },
      result.commit,
    );
    await appendRunEvents(tx, run.id, events);
    const updated = await transitionRun(tx, {
      runId: run.id,
      expectedStateVersion: job.expectedStateVersion,
      to,
      usage,
      pendingConfirmation: pending,
      ...(isTerminal(to)
        ? { terminalReason: result.terminalReason ?? null }
        : {}),
      ...(to === "FAILED"
        ? {
            // Transient failures can be retried from the UI (RETRY from FAILED).
            error: {
              ...(result.error ?? { code: "UNKNOWN", message: "unknown" }),
              transient:
                result.transient === true ||
                result.terminalReason === "STEP_RETRIES_EXHAUSTED",
              failedState: run.state,
            },
          }
        : {}),
      ...(result.iteration !== undefined
        ? { iteration: result.iteration }
        : {}),
    });
    await setExperimentStatus(tx, snap.experiment.id, experimentStatusFor(to));
    if (isRunnable(to))
      await enqueueRunStep(
        deps.boss,
        { runId: run.id, expectedStateVersion: updated.stateVersion },
        raw,
      );
    return true;
  });
  if (!committed) return { outcome: "stale", state: run.state };
  deps.log?.("run_step_committed", {
    runId: run.id,
    from: run.state,
    to,
    event: result.event,
  });
  return { outcome: "committed", from: run.state, to };
}
