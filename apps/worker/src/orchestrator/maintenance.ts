import { nextState } from "@tessaloom/agent";
import {
  appendRunEvents,
  enqueueRunStep,
  listExpiredPausedRuns,
  listStalledRuns,
  lockRunAtVersion,
  setExperimentStatus,
  transitionRun,
  withPgTx,
  type DbHandle,
  type PgBoss,
} from "@tessaloom/db";

export const PAUSED_EXPIRY_MS = 24 * 3_600_000;
export const STALLED_AFTER_MS = 15 * 60_000;

/** `maintenance.expire-paused-runs`: paused for > 24 h → CANCELLED (EXPIRED). */
export async function expirePausedRuns(
  handle: DbHandle,
  now: Date,
  expiryMs = PAUSED_EXPIRY_MS,
): Promise<number> {
  const runs = await listExpiredPausedRuns(
    handle.db,
    new Date(now.getTime() - expiryMs),
  );
  let expired = 0;
  for (const candidate of runs) {
    const done = await withPgTx(handle, async (tx) => {
      const run = await lockRunAtVersion(
        tx,
        candidate.id,
        candidate.stateVersion,
      );
      if (!run) return false;
      const to = nextState(run.state, "CANCEL");
      await appendRunEvents(tx, run.id, [
        {
          type: "STATE_ENTERED",
          state: to,
          summary: `Entered ${to}`,
          payload: { from: run.state, event: "CANCEL" },
        },
        {
          type: "RUN_CANCELLED",
          state: to,
          summary: "Run expired after waiting 24 hours for confirmation",
          payload: { terminalReason: "EXPIRED" },
        },
      ]);
      await transitionRun(tx, {
        runId: run.id,
        expectedStateVersion: run.stateVersion,
        to,
        pendingConfirmation: null,
        terminalReason: "EXPIRED",
      });
      await setExperimentStatus(tx, run.experimentId, "CANCELLED");
      return true;
    });
    if (done) expired++;
  }
  return expired;
}

/**
 * `maintenance.recover-runs`: re-enqueue runnable runs with no activity (for example a job
 * lost to a crash after its retries). Duplicate keys are dropped by the queue policy, and a
 * stale job is a no-op thanks to `state_version`.
 */
export async function recoverStalledRuns(
  handle: DbHandle,
  boss: PgBoss,
  now: Date,
  stalledMs = STALLED_AFTER_MS,
): Promise<number> {
  const runs = await listStalledRuns(
    handle.db,
    new Date(now.getTime() - stalledMs),
  );
  for (const run of runs)
    await enqueueRunStep(boss, {
      runId: run.id,
      expectedStateVersion: run.stateVersion,
    });
  return runs.length;
}
