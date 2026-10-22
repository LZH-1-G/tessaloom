import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { RunBudget, isTerminal, uuidv7, type RunState } from "@tessaloom/core";
import { withTx, type DbHandle, type Executor, type Tx } from "../client";
import { AdmissionError, NotFoundError } from "../errors";
import {
  agentRuns,
  demoAccessGrants,
  experiments,
  llmSpendReservations,
  projects,
  workspaces,
} from "../schema";
import { consumeWithinLimit, getUsage, incrementUsage, utcDay } from "./ops";

/**
 * M10-A public demo cost safety. Paid work is admitted by policy, and every paid LLM attempt
 * reserves its upper-bound cost in one transaction against every cap before the provider is
 * called. All checks are server-side and fail closed.
 *
 * - `off`: no new runs and no LLM spend at all (kill switch).
 * - `invite`: only workspaces holding an active demo grant (staging/production default).
 * - `open`: any workspace, still bounded by every cap (development/test default).
 */
export type RunAccess = "off" | "invite" | "open";

export interface RunAdmission {
  access: RunAccess;
  /** Non-terminal runs (including paused gates) one workspace may hold. */
  maxActivePerWorkspace: number;
  /** Runs doing work right now (not paused at a gate) across all workspaces. */
  maxWorkingGlobal: number;
  /** New runs per workspace per UTC day. */
  dailyRunsPerWorkspace: number;
}

export interface LlmSpendLimits {
  access: RunAccess;
  globalDailyUsd: number;
  workspaceDailyUsd: number;
  experimentUsd: number;
}

export const LLM_SPEND_METRIC = "llm_usd_micros";
export const toMicros = (usd: number) => Math.ceil(usd * 1_000_000);

// --- Demo access grants ---

/** Only a peppered hash of an access code is stored (same pepper as share tokens). */
export const hashDemoCode = (code: string, pepper: string) =>
  createHash("sha256").update(`demo-access:${code}${pepper}`).digest("hex");

export async function createDemoGrant(
  db: Executor,
  input: {
    label: string;
    codeHash: string;
    expiresAt: Date;
    maxRuns: number;
    maxLlmUsd: number;
  },
) {
  const [row] = await db
    .insert(demoAccessGrants)
    .values({
      id: uuidv7(),
      label: input.label,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      maxRuns: input.maxRuns,
      maxLlmUsdMicros: toMicros(input.maxLlmUsd),
    })
    .returning();
  return row!;
}

/** Revocation takes effect immediately: admission and every later reservation check it. */
export async function revokeDemoGrant(db: Executor, grantId: string) {
  const rows = await db
    .update(demoAccessGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(demoAccessGrants.id, grantId), isNull(demoAccessGrants.revokedAt)),
    )
    .returning({ id: demoAccessGrants.id });
  return rows.length > 0;
}

export async function listDemoGrants(db: Executor) {
  return db
    .select({
      id: demoAccessGrants.id,
      label: demoAccessGrants.label,
      createdAt: demoAccessGrants.createdAt,
      expiresAt: demoAccessGrants.expiresAt,
      revokedAt: demoAccessGrants.revokedAt,
      maxRuns: demoAccessGrants.maxRuns,
      maxLlmUsdMicros: demoAccessGrants.maxLlmUsdMicros,
    })
    .from(demoAccessGrants)
    .orderBy(demoAccessGrants.createdAt);
}

const grantActive = (
  g: { revokedAt: Date | null; expiresAt: Date } | null | undefined,
  now = new Date(),
) => !!g && !g.revokedAt && g.expiresAt.getTime() > now.getTime();

/** Attach an active grant to the workspace. Unknown, revoked, or expired codes look the same. */
export async function redeemDemoGrant(
  db: Executor,
  workspaceId: string,
  codeHash: string,
): Promise<boolean> {
  const [grant] = await db
    .select()
    .from(demoAccessGrants)
    .where(eq(demoAccessGrants.codeHash, codeHash));
  if (!grantActive(grant)) return false;
  await db
    .update(workspaces)
    .set({ demoGrantId: grant!.id })
    .where(eq(workspaces.id, workspaceId));
  return true;
}

/** What the UI may show about paid-work access for this workspace (no grant internals). */
export async function workspaceRunAccess(
  db: Executor,
  workspaceId: string,
  access: RunAccess,
): Promise<{
  access: RunAccess;
  allowed: boolean;
  grant: { label: string; expiresAt: string } | null;
}> {
  const [row] = await db
    .select({ grant: demoAccessGrants })
    .from(workspaces)
    .leftJoin(demoAccessGrants, eq(demoAccessGrants.id, workspaces.demoGrantId))
    .where(eq(workspaces.id, workspaceId));
  const grant = grantActive(row?.grant) ? row!.grant! : null;
  return {
    access,
    allowed: access === "open" || (access === "invite" && !!grant),
    grant: grant
      ? { label: grant.label, expiresAt: grant.expiresAt.toISOString() }
      : null,
  };
}

// --- Run admission (called inside the run-creating transaction) ---

async function workspaceOf(tx: Tx | Executor, experimentId: string) {
  const [row] = await tx
    .select({ workspaceId: projects.workspaceId, grant: demoAccessGrants })
    .from(experiments)
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(demoAccessGrants, eq(demoAccessGrants.id, workspaces.demoGrantId))
    .where(eq(experiments.id, experimentId));
  if (!row) throw new NotFoundError("Experiment not found");
  return row;
}

/**
 * Admit a new run or refuse it. One transaction-scoped advisory lock serializes admissions,
 * so parallel requests cannot both pass the concurrency counts; the daily and grant run
 * allowances are atomic conditional upserts in the same transaction (rolled back on refusal).
 */
export async function admitRun(
  tx: Tx | Executor,
  experimentId: string,
  admission: RunAdmission,
  resumeRunId?: string,
) {
  if (admission.access === "off")
    throw new AdmissionError(
      "PAID_RUNS_DISABLED",
      "New AI runs are paused right now. Saved projects and shared links still work.",
    );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('tessaloom:run-admission', 0))`,
  );
  const { workspaceId, grant } = await workspaceOf(tx, experimentId);
  if (admission.access === "invite" && !grantActive(grant))
    throw new AdmissionError(
      "RUN_ACCESS_REQUIRED",
      "AI runs on this demo need an access code. You can still explore the samples and shared links.",
    );
  const counts = await tx.execute<{ mine: string; working: string }>(sql`
    SELECT
      count(*) FILTER (WHERE p.workspace_id = ${workspaceId}) AS mine,
      count(*) FILTER (WHERE r.state::text NOT LIKE 'AWAITING_%') AS working
    FROM agent_runs r
    JOIN experiments e ON e.id = r.experiment_id
    JOIN projects p ON p.id = e.project_id
    WHERE r.state NOT IN ('COMPLETED','COMPLETED_WITH_LIMITS','FAILED','CANCELLED')
      AND (${resumeRunId ?? null}::uuid IS NULL OR r.id <> ${resumeRunId ?? null}::uuid)`);
  const mine = Number(counts.rows[0]?.mine ?? 0);
  const working = Number(counts.rows[0]?.working ?? 0);
  if (mine >= admission.maxActivePerWorkspace)
    throw new AdmissionError(
      "RUN_LIMIT",
      `You already have ${mine} runs in progress. Finish or cancel one first.`,
    );
  if (working >= admission.maxWorkingGlobal)
    throw new AdmissionError(
      "BUSY",
      "The studio is busy. Please try again in a few minutes.",
    );
  if (resumeRunId) return; // Existing run: recheck access/capacity without charging creation twice.
  const daily = await consumeWithinLimit(tx, {
    scope: "workspace",
    scopeId: workspaceId,
    metric: "runs_started",
    limit: admission.dailyRunsPerWorkspace,
  });
  if (daily === null)
    throw new AdmissionError(
      "RUN_LIMIT",
      "This workspace reached today's run allowance. Saved work stays available.",
    );
  if (admission.access === "invite") {
    const used = await consumeWithinLimit(tx, {
      scope: "grant",
      scopeId: grant!.id,
      metric: "runs",
      limit: grant!.maxRuns,
      day: "total",
    });
    if (used === null)
      throw new AdmissionError(
        "RUN_LIMIT",
        "This access code has used all of its runs.",
      );
  }
}

// --- LLM spend ledger (worker) ---

export type SpendDenial = {
  ok: false;
  code:
    | "PAID_RUNS_DISABLED"
    | "RUN_ACCESS_REQUIRED"
    | "RUN_STOPPED"
    | "GLOBAL_BUDGET"
    | "WORKSPACE_BUDGET"
    | "EXPERIMENT_BUDGET"
    | "RUN_BUDGET"
    | "GRANT_BUDGET";
  message: string;
};

class Denied extends Error {
  constructor(readonly denial: SpendDenial) {
    super(denial.code);
  }
}

const deny = (code: SpendDenial["code"], message: string): never => {
  throw new Denied({ ok: false, code, message });
};

/**
 * Reserve the upper-bound cost of one provider attempt against the global daily, workspace
 * daily, experiment, run, and (invite mode) grant caps, all in one transaction. Any refusal
 * rolls every counter back. The reservation row is the audit trail settlement reconciles.
 */
export async function reserveLlmSpend(
  handle: DbHandle,
  input: {
    runId: string;
    model: string;
    upperBoundUsd: number;
    maxOutputTokens?: number;
    limits: LlmSpendLimits;
  },
): Promise<{ ok: true; reservationId: string } | SpendDenial> {
  if (
    !Number.isFinite(input.upperBoundUsd) ||
    input.upperBoundUsd < 0 ||
    !Number.isSafeInteger(toMicros(input.upperBoundUsd))
  )
    throw new Error("Invalid spend reservation");
  const outputTokens = input.maxOutputTokens ?? 0;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0)
    throw new Error("Invalid output token reservation");
  const micros = toMicros(input.upperBoundUsd);
  try {
    return await withTx(handle.db, async (tx) => {
      const { limits } = input;
      // Serialize spend authorization with settlement and check a persistent billing alarm.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('tessaloom:llm-spend', 0))`,
      );
      if (
        await getUsage(tx, {
          scope: "global",
          scopeId: "all",
          metric: "llm_billing_overrun",
          day: "total",
        })
      )
        deny(
          "PAID_RUNS_DISABLED",
          "AI work is paused pending a billing review.",
        );
      if (limits.access === "off")
        deny("PAID_RUNS_DISABLED", "New AI work is paused (RUN_ACCESS=off).");
      const [run] = await tx
        .select({
          state: agentRuns.state,
          budget: agentRuns.budget,
          cancelRequestedAt: agentRuns.cancelRequestedAt,
          experimentId: agentRuns.experimentId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .for("update");
      if (!run) throw new NotFoundError("Run not found");
      const budget = RunBudget.parse(run.budget);
      if (run.cancelRequestedAt || isTerminal(run.state as RunState))
        deny("RUN_STOPPED", "The run was cancelled or has finished.");
      const { workspaceId, grant } = await workspaceOf(tx, run.experimentId);
      const granted = grantActive(grant);
      if (limits.access === "invite" && !granted)
        deny(
          "RUN_ACCESS_REQUIRED",
          "The workspace has no active demo access grant.",
        );
      const day = utcDay();
      const caps: [
        "global" | "workspace" | "experiment" | "run" | "grant",
        string,
        string,
        number,
        SpendDenial["code"],
      ][] = [
        [
          "global",
          "all",
          day,
          toMicros(limits.globalDailyUsd),
          "GLOBAL_BUDGET",
        ],
        [
          "workspace",
          workspaceId,
          day,
          toMicros(limits.workspaceDailyUsd),
          "WORKSPACE_BUDGET",
        ],
        [
          "experiment",
          run.experimentId,
          "total",
          toMicros(limits.experimentUsd),
          "EXPERIMENT_BUDGET",
        ],
        [
          "run",
          input.runId,
          "total",
          toMicros(
            (run.budget as { maxEstimatedCostUsd?: number })
              .maxEstimatedCostUsd ?? 0,
          ),
          "RUN_BUDGET",
        ],
      ];
      if (limits.access === "invite")
        caps.push([
          "grant",
          grant!.id,
          "total",
          grant!.maxLlmUsdMicros,
          "GRANT_BUDGET",
        ]);
      for (const [scope, scopeId, d, limit, code] of caps) {
        const value = await consumeWithinLimit(tx, {
          scope,
          scopeId,
          metric: LLM_SPEND_METRIC,
          limit,
          amount: micros,
          day: d,
        });
        if (value === null)
          deny(code, `The ${scope} AI budget does not cover this call.`);
      }
      // These durable allowances are never refunded, including after a crash/unknown bill.
      // State-machine usage snapshots alone cannot bound repeated execution of a lost step.
      for (const [metric, amount, limit] of [
        ["llm_attempts", 1, budget.maxLlmCalls],
        ["llm_output_reserved", outputTokens, budget.maxLlmOutputTokens],
      ] as const) {
        if (
          (await consumeWithinLimit(tx, {
            scope: "run",
            scopeId: input.runId,
            day: "total",
            metric,
            amount,
            limit,
          })) === null
        )
          deny(
            "RUN_BUDGET",
            "The run's call or output-token allowance is exhausted.",
          );
      }
      const id = uuidv7();
      await tx.insert(llmSpendReservations).values({
        id,
        runId: input.runId,
        workspaceId,
        experimentId: run.experimentId,
        grantId: limits.access === "invite" ? grant!.id : null,
        model: input.model,
        day,
        reservedMicros: micros,
      });
      return { ok: true as const, reservationId: id };
    });
  } catch (error) {
    if (error instanceof Denied) return error.denial;
    throw error;
  }
}

/**
 * Replace a reservation with the actual cost. `actualUsd = null` means the outcome is unknown
 * (the provider call threw): the full reservation stays charged. Settling twice is a no-op.
 */
export async function settleLlmSpend(
  handle: DbHandle,
  reservationId: string,
  actualUsd: number | null,
): Promise<void> {
  if (
    actualUsd !== null &&
    (!Number.isFinite(actualUsd) ||
      actualUsd < 0 ||
      !Number.isSafeInteger(toMicros(actualUsd)))
  )
    throw new Error("Invalid spend settlement");
  await withTx(handle.db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('tessaloom:llm-spend', 0))`,
    );
    const [row] = await tx
      .update(llmSpendReservations)
      .set({
        status: actualUsd === null ? "UNKNOWN" : "SETTLED",
        actualMicros: actualUsd === null ? null : toMicros(actualUsd),
        settledAt: new Date(),
      })
      .where(
        and(
          eq(llmSpendReservations.id, reservationId),
          eq(llmSpendReservations.status, "RESERVED"),
        ),
      )
      .returning();
    if (!row || actualUsd === null) return;
    const delta = toMicros(actualUsd) - row.reservedMicros;
    if (delta === 0) return;
    if (delta > 0)
      await incrementUsage(tx, {
        scope: "global",
        scopeId: "all",
        metric: "llm_billing_overrun",
        day: "total",
      });
    const scopes: [
      "global" | "workspace" | "experiment" | "run" | "grant",
      string,
      string,
    ][] = [
      ["global", "all", row.day],
      ["workspace", row.workspaceId, row.day],
      ["experiment", row.experimentId, "total"],
      ["run", row.runId, "total"],
    ];
    if (row.grantId) scopes.push(["grant", row.grantId, "total"]);
    for (const [scope, scopeId, day] of scopes)
      await incrementUsage(tx, {
        scope,
        scopeId,
        metric: LLM_SPEND_METRIC,
        amount: delta,
        day,
      });
  });
}

/** Today's global LLM spend (reserved and settled) against the cap, for status and alerts. */
export async function globalLlmSpendToday(db: Executor) {
  const result = await db.execute<{ value: string | null }>(sql`
    SELECT value FROM usage_counters
    WHERE scope = 'global' AND scope_id = 'all' AND metric = ${LLM_SPEND_METRIC} AND day = ${utcDay()}`);
  return Number(result.rows[0]?.value ?? 0) / 1_000_000;
}
