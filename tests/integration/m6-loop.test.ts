import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildPorts,
  buildRunConfig,
  createQlooAdapter,
} from "../../apps/worker/src/compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
} from "../../apps/worker/src/llm";
import { activeSeconds } from "../../apps/worker/src/orchestrator/context";
import type { RunnerDeps } from "../../apps/worker/src/orchestrator/runner";
import {
  QUEUES,
  confirmRun,
  experimentView,
  getRun,
  loadRunSnapshot,
  sql,
  startExploration,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { PromptRegistry } from "../../packages/llm-gateway/src";
import { drain, seedProject, startBoss } from "./helpers/exploration";
import { createTestDatabase } from "./helpers/test-db";

/**
 * M6 end to end on the synthetic transport and the scripted provider ($0, no network):
 * TEST_PLAN §7.1 pointer verification with raw retention on, and HL-A4 (the loop terminates
 * within its limits) as a property test over 50 varied runs.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;

const RUN_CONFIG = buildRunConfig({
  llmModel: "scripted-demo",
  llmFallbackModel: "scripted-demo-fallback",
  promptVersions: new PromptRegistry().versions(),
  harnessVersion: "synthetic",
});

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

function deps(rawRetention: "off" | "on"): RunnerDeps {
  const qloo = createQlooAdapter(handle.db, {
    mode: "synthetic",
    appEnv: "test",
    harnessVersion: "synthetic",
    dailyLimit: 100_000,
    rateLimitPerMin: 100_000,
    rawRetention,
  });
  const llm = createLlmGateway(
    {
      LLM_PROVIDER: "scripted",
      LLM_MODEL: "scripted-demo",
      LLM_FALLBACK_MODEL: "scripted-demo-fallback",
      LLM_MODE: "standard",
    },
    createDbLlmRecorder(handle.db),
  );
  return { handle, boss, ports: buildPorts(qloo, llm), cancelPollMs: 50 };
}

/** Deterministic PRNG (mulberry32) so a failing case is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic-transport behaviors: typed multi-word names resolve exactly, single-word typed
// names come back with alternatives (H2), untyped names go through describe + find_tags.
const INTERESTS = [
  { text: "Paper Atlas Stories", domainHint: "book" },
  { text: "Stardew Harvest Tales", domainHint: "videogame" },
  { text: "Neon Harbor Nights", domainHint: "movie" },
  { text: "Velvet Static Radio", domainHint: "artist" },
  { text: "Lantern Road", domainHint: "tv_show" },
  { text: "Midnight Diner Hour", domainHint: "podcast" },
  { text: "Jazz", domainHint: "artist" },
  { text: "cumbia" },
] as const;

function briefFor(r: () => number) {
  const pool = [...INTERESTS].sort(() => r() - 0.5);
  const interests = pool.slice(0, 2 + Math.floor(r() * 3));
  return {
    title: "Weeknight collision",
    challenge:
      "A small venue wants a recurring evening that mixes cultural worlds.",
    interests,
    venue: {
      type: r() < 0.5 ? "cafe" : "bar",
      ...(r() < 0.5 ? { localityText: "Lisbon" } : {}),
      capacity: 20 + Math.floor(r() * 80),
    },
    constraints: {
      budgetBand: (["low", "medium", "high"] as const)[Math.floor(r() * 3)],
      durationMinutes: 90 + Math.floor(r() * 4) * 30,
    },
    goals: ["Attract new weekday visitors"],
  };
}

/** Drains the queue and answers every gate like a user taking the first offered option. */
async function driveToEnd(
  d: RunnerDeps,
  ids: { workspaceId: string; experimentId: string; runId: string },
  answers: { tension: number; select: boolean },
) {
  for (let guard = 0; guard < 12; guard++) {
    await drain(d, 80);
    const run = await getRun(handle.db, ids.runId);
    const pending = run.pendingConfirmation as
      ({ kind: string } & Record<string, unknown>) | null;
    if (!pending) return run;
    let body: unknown;
    if (pending.kind === "BRIEF")
      body = {
        kind: "BRIEF",
        briefVersionId: pending.briefVersionId,
        action: "confirm",
      };
    else if (pending.kind === "ENTITIES") {
      const view = await experimentView(
        handle.db,
        ids.workspaceId,
        ids.experimentId,
      );
      body = {
        kind: "ENTITIES",
        selections: (pending.interestIndexes as number[]).map(
          (interestIndex) => {
            const row = view.resolutions.find(
              (r) => r.interestIndex === interestIndex,
            )!;
            const candidates = row.candidates as {
              entities: { qlooId: string }[];
              tags: { tagId: string }[];
            };
            const qlooId =
              candidates.entities[0]?.qlooId ?? candidates.tags[0]?.tagId;
            return {
              interestIndex,
              choice: qlooId
                ? { type: "candidate", qlooId }
                : { type: "exclude" },
            };
          },
        ),
      };
    } else if (pending.kind === "POOL")
      body = { kind: "POOL", tension: answers.tension };
    else if (pending.kind === "HYPOTHESIS_SELECTION") {
      const ranked = pending.hypothesisIds as string[];
      body = {
        kind: "HYPOTHESIS_SELECTION",
        selectedHypothesisIds: answers.select ? ranked.slice(0, 1) : [],
      };
    } else throw new Error(`unexpected gate ${pending.kind}`);
    await confirmRun(handle, boss, ids.workspaceId, ids.runId, body);
  }
  throw new Error("run did not finish within 12 gates");
}

async function start(content: Record<string, unknown>, tension?: number) {
  const { workspace, project, brief } = await seedProject(handle, content);
  const started = await startExploration(handle, boss, {
    workspaceId: workspace.id,
    projectId: project.id,
    briefVersionId: brief.id,
    mode: "fixture",
    runConfig: RUN_CONFIG,
    ...(tension ? { variables: { collisionTension: tension } } : {}),
  });
  return {
    workspaceId: workspace.id,
    experimentId: started.experimentId,
    runId: started.runId,
  };
}

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
