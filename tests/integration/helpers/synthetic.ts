import {
  buildPorts,
  buildRunConfig,
  createQlooAdapter,
} from "../../../apps/worker/src/compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
} from "../../../apps/worker/src/llm";
import type { RunnerDeps } from "../../../apps/worker/src/orchestrator/runner";
import type { RunConfig } from "../../../packages/core/src";
import {
  confirmRun,
  experimentView,
  getRun,
  startExploration,
  type DbHandle,
  type PgBoss,
} from "../../../packages/db/src";
import {
  PromptRegistry,
  type LlmGateway,
} from "../../../packages/llm-gateway/src";
import { drain, seedProject } from "./exploration";

/**
 * Shared driver for full runs on the synthetic transport and the scripted provider ($0, no
 * network): build worker deps, start an EXPLORATION, and answer every gate.
 */
export const RUN_CONFIG = buildRunConfig({
  llmModel: "scripted-demo",
  llmFallbackModel: "scripted-demo-fallback",
  promptVersions: new PromptRegistry().versions(),
  harnessVersion: "synthetic",
});

/** Deterministic PRNG (mulberry32) so a failing case is reproducible from its seed. */
export function rng(seed: number) {
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
export const INTERESTS = [
  { text: "Paper Atlas Stories", domainHint: "book" },
  { text: "Stardew Harvest Tales", domainHint: "videogame" },
  { text: "Neon Harbor Nights", domainHint: "movie" },
  { text: "Velvet Static Radio", domainHint: "artist" },
  { text: "Lantern Road", domainHint: "tv_show" },
  { text: "Midnight Diner Hour", domainHint: "podcast" },
  { text: "Jazz", domainHint: "artist" },
  { text: "cumbia" },
] as const;

export function briefFor(r: () => number) {
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

export function syntheticHarness(
  handle: DbHandle,
  boss: PgBoss,
  // A different LLM (e.g. Gemini over mocked HTTP) and the run config that names it.
  options: { llm?: () => LlmGateway | null; runConfig?: RunConfig } = {},
) {
  const runConfig = options.runConfig ?? RUN_CONFIG;
  function deps(rawRetention: "off" | "on"): RunnerDeps {
    const qloo = createQlooAdapter(handle.db, {
      mode: "synthetic",
      appEnv: "test",
      harnessVersion: "synthetic",
      dailyLimit: 100_000,
      rateLimitPerMin: 100_000,
      rawRetention,
    });
    const llm = options.llm
      ? options.llm()
      : createLlmGateway(
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

  /** Drains the queue and answers every gate like a user taking the first offered option. */
  async function driveToEnd(
    d: RunnerDeps,
    ids: { workspaceId: string; experimentId: string; runId: string },
    answers: {
      tension: number;
      select: boolean;
      counterfactual?: "run" | "cancel";
      /** Stop (without answering) when this gate opens. */
      stopAt?: string;
    },
  ) {
    for (let guard = 0; guard < 12; guard++) {
      await drain(d, 80);
      const run = await getRun(handle.db, ids.runId);
      const pending = run.pendingConfirmation as
        ({ kind: string } & Record<string, unknown>) | null;
      if (!pending || pending.kind === answers.stopAt) return run;
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
      } else if (pending.kind === "COUNTERFACTUAL_COST")
        body = {
          kind: "COUNTERFACTUAL_COST",
          action: answers.counterfactual ?? "run",
        };
      else throw new Error(`unexpected gate ${pending.kind}`);
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
      runConfig,
      ...(tension ? { variables: { collisionTension: tension } } : {}),
    });
    return {
      workspaceId: workspace.id,
      experimentId: started.experimentId,
      runId: started.runId,
    };
  }

  return { deps, driveToEnd, start };
}
