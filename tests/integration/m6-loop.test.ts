import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activeSeconds } from "../../apps/worker/src/orchestrator/context";
import {
  QUEUES,
  experimentView,
  loadRunSnapshot,
  sql,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { startBoss } from "./helpers/exploration";
import { briefFor, rng, syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/**
 * M6 end to end on the synthetic transport and the scripted provider ($0, no network):
 * TEST_PLAN §7.1 pointer verification with raw retention on, and HL-A4 (the loop terminates
 * within its limits) as a property test over 50 varied runs.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let deps: ReturnType<typeof syntheticHarness>["deps"];
let driveToEnd: ReturnType<typeof syntheticHarness>["driveToEnd"];
let start: ReturnType<typeof syntheticHarness>["start"];

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  ({ deps, driveToEnd, start } = syntheticHarness(handle, boss));
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

function resolvePointer(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = Array.isArray(cur)
      ? cur[Number(key)]
      : (cur as Record<string, unknown> | null)?.[key];
  }
  return cur;
}

describe("M6 loop on the synthetic transport (scripted provider, $0)", () => {
  it("§7.1: every evidence fact's pointer deep-equals the retained raw response; rationale is recorded", async () => {
    const ids = await start(briefFor(rng(7)));
    const run = await driveToEnd(deps("on"), ids, {
      tension: 0.55,
      select: true,
    });
    expect(run.state).toBe("COMPLETED");

    const rows = await handle.db.execute<{
      facts: {
        jsonPointer: string;
        value: unknown;
        verifiedAtIngest: boolean;
      }[];
      raw: unknown;
      raw_retained: boolean;
      rationale: string | null;
      provenance_class: string;
      stance: string;
    }>(
      sql`SELECT e.facts, s.raw, s.raw_retained, e.rationale, e.provenance_class, e.stance
          FROM evidence_records e
          JOIN tool_invocations t ON t.id = e.tool_invocation_id
          JOIN qloo_response_snapshots s ON s.id = t.snapshot_id
          WHERE e.experiment_id = ${ids.experimentId}`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    let checked = 0;
    for (const r of rows.rows) {
      expect(r.raw_retained).toBe(true);
      expect(r.rationale).toBeTruthy();
      expect(r.rationale).toMatch(
        new RegExp(`^(${r.stance}|Untestable|Not tested)`),
      );
      expect(r.provenance_class).toBe("DEVELOPMENT_FIXTURE");
      for (const f of r.facts) {
        expect(f.verifiedAtIngest).toBe(true);
        expect(resolvePointer(r.raw, f.jsonPointer)).toEqual(f.value);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);

    // HL-A5 data side: retired hypotheses stay queryable, with their evidence.
    const view = await experimentView(
      handle.db,
      ids.workspaceId,
      ids.experimentId,
    );
    const pinned = view.hypotheses.filter((h) => h.userPinned);
    expect(pinned).toHaveLength(1);
    // Every scored hypothesis carries an explained feasibility (feasibility-1.0.0).
    for (const h of view.hypotheses.filter((x) => x.compositeScore !== null))
      expect(
        (h.scoreBreakdown as { feasibility?: { version: string } }).feasibility
          ?.version,
      ).toBe("feasibility-1.0.0");
  });

  it("HL-A4: 50 varied runs never exceed maxIterations, maxQlooCalls, maxLlmCalls or wall clock", async () => {
    const d = deps("off");
    const terminal = new Map<string, number>();
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed * 7919);
      const ids = await start(briefFor(r), (4 + Math.round(r() * 14)) / 20);
      // Vary the budget too: tight budgets must stop the loop, never overrun it.
      const budget = {
        maxIterations: 1 + Math.floor(r() * 3),
        maxQlooCalls: 18 + Math.floor(r() * 30),
        maxLlmCalls: 3 + Math.floor(r() * 12),
      };
      await handle.db.execute(
        sql`UPDATE agent_runs SET budget = budget || ${JSON.stringify(budget)}::jsonb WHERE id = ${ids.runId}`,
      );
      const run = await driveToEnd(d, ids, {
        tension: 0.2 + r() * 0.7,
        select: r() < 0.5,
      });
      const usage = run.usage as { qlooCalls: number; llmCalls: number };
      const label = `seed ${seed} ${JSON.stringify(budget)} → ${run.state}/${run.terminalReason}`;
      expect(["COMPLETED", "COMPLETED_WITH_LIMITS"], label).toContain(
        run.state,
      );
      expect(run.iteration, label).toBeLessThanOrEqual(budget.maxIterations);
      expect(usage.qlooCalls, label).toBeLessThanOrEqual(budget.maxQlooCalls);
      expect(usage.llmCalls, label).toBeLessThanOrEqual(budget.maxLlmCalls);
      const counted = await handle.db.execute<{ q: string; l: string }>(
        sql`SELECT (SELECT count(*) FROM tool_invocations WHERE run_id = ${ids.runId} AND data_origin <> 'CACHE')::text AS q,
                   (SELECT count(*) FROM llm_invocations WHERE run_id = ${ids.runId})::text AS l`,
      );
      expect(Number(counted.rows[0]!.q), label).toBeLessThanOrEqual(
        budget.maxQlooCalls,
      );
      expect(Number(counted.rows[0]!.l), label).toBeLessThanOrEqual(
        budget.maxLlmCalls,
      );
      const snap = (await loadRunSnapshot(handle.db, ids.runId))!;
      expect(
        activeSeconds(
          snap.stateEvents,
          run.finishedAt ? new Date(run.finishedAt) : new Date(),
        ),
        label,
      ).toBeLessThanOrEqual(
        (run.budget as { wallClockSeconds: number }).wallClockSeconds,
      );
      const key = `${run.state}:${run.terminalReason ?? "-"}`;
      terminal.set(key, (terminal.get(key) ?? 0) + 1);
    }
    // The property is only meaningful if both natural ends and budget stops occurred.
    expect([...terminal.keys()].some((k) => k.startsWith("COMPLETED:"))).toBe(
      true,
    );
    expect(
      [...terminal.keys()].some((k) =>
        k.startsWith("COMPLETED_WITH_LIMITS:BUDGET"),
      ),
    ).toBe(true);
    console.info("HL-A4 terminal outcomes", Object.fromEntries(terminal));
  }, 300_000);
});
