import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPorts,
  buildRunConfig,
  createQlooAdapter,
} from "../../../apps/worker/src/compose";
import {
  createDbLlmRecorder,
  createLlmGateway,
} from "../../../apps/worker/src/llm";
import {
  runStep,
  type RunnerDeps,
} from "../../../apps/worker/src/orchestrator/runner";
import type { Ports } from "../../../packages/agent/src";
import {
  QUEUES,
  createBoss,
  createBriefVersion,
  createProject,
  createWorkspace,
  withTx,
  type DbHandle,
  type JobWithMetadata,
  type PgBoss,
  type RunStepJob,
} from "../../../packages/db/src";
import {
  PromptRegistry,
  ScriptedLlmProvider,
  type ProviderRequest,
} from "../../../packages/llm-gateway/src";
import {
  CompareAudiencesInput,
  DescribeEntityInput,
  EntityTagsInput,
  FIXTURE_LABEL,
  RankInput,
  RecommendInput,
  fixturePath,
  toHarness,
  type HarnessCall,
} from "../../../packages/qloo-adapter/src";

// ---------------------------------------------------------------------------
// Synthetic, labeled fixtures (ADR-014). All names and values are fictional.

export class FixtureLibrary {
  private constructor(readonly root: string) {}

  static async create(): Promise<FixtureLibrary> {
    return new FixtureLibrary(
      await mkdtemp(path.join(tmpdir(), "tl-fixtures-")),
    );
  }

  async put(call: HarnessCall, payload: unknown): Promise<void> {
    const file = fixturePath(this.root, call);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        _fixture: { synthetic: true, label: FIXTURE_LABEL },
        payload,
      }),
    );
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

const envelope = (operation: string, extra: Record<string, unknown>) => ({
  schema_version: "1.0-preview.1",
  operation,
  status: "ok",
  provenance: { source: "Qloo API", endpoint: "/v2/insights", requests: [] },
  execution: {
    transport: "direct",
    correlation_id: `fx-${operation}`,
    duration_ms: 1,
  },
  ...extra,
});

export function describePayload(
  input: string,
  selected: { id: string; name: string; type: string },
  alternatives: { id: string; name: string; type: string }[] = [],
) {
  return envelope("describe", {
    results: [
      {
        entity_id: selected.id,
        name: selected.name,
        popularity: 0.9,
        properties: { description: "synthetic" },
      },
    ],
    result_count: 1,
    resolution: {
      outcomes: [
        {
          input,
          status: "resolved",
          match: "exact",
          selected: { ...selected, popularity: 0.9 },
          alternatives: alternatives.map((a) => ({ ...a, popularity: 0.5 })),
          provenance: {
            provider_id: "qloo_api",
            strategy: "exact_name_context_or_choice",
            endpoint: "/search",
          },
        },
      ],
    },
  });
}

/** `ids` in rank order; affinities fall steeply so evaluators can discriminate. */
export function rankedPayload(
  operation: string,
  domain: string,
  ids: string[],
) {
  return envelope(operation, {
    results: ids.map((id, i) => ({
      entity_id: id,
      name: `Fixture ${id}`,
      type: "urn:entity",
      subtype: `urn:entity:${domain}`,
      popularity: 0.5,
      affinity: Number((0.95 - i * 0.03).toFixed(2)),
    })),
    result_count: ids.length,
  });
}

/** entity_tags (V1 shape `{ id, name, type, popularity, affinity }`); ids are fictional. */
export function tagsPayload(tags: [string, string][]) {
  return envelope("entity_tags", {
    results: tags.map(([id, type], i) => ({
      id: `urn:tag:${type}:${id}`,
      name: `Tag ${id}`,
      type: `urn:tag:${type}`,
      popularity: 0.5,
      affinity: Number((0.9 - i * 0.05).toFixed(2)),
    })),
    result_count: tags.length,
  });
}

export function comparePayload(sharedTagIds: string[]) {
  return envelope("compare_audiences", {
    results: {
      tags: sharedTagIds.map((id) => ({
        tag_id: id,
        name: `Tag ${id}`,
        subtype: "urn:tag:keyword:qloo",
      })),
      a: [],
      b: [],
      matchEntities: [],
    },
  });
}

export const call = {
  describe: (entity: string, type?: string) =>
    toHarness.describeEntity(
      DescribeEntityInput.parse({ entity, ...(type ? { type } : {}) }),
    ),
  recommend: (input: Record<string, unknown>) =>
    toHarness.recommend(RecommendInput.parse(input)),
  rank: (input: Record<string, unknown>) =>
    toHarness.rank(RankInput.parse(input)),
  compare: (input: Record<string, unknown>) =>
    toHarness.compareAudiences(CompareAudiencesInput.parse(input)),
  entityTags: (id: string) =>
    toHarness.entityTags(EntityTagsInput.parse({ entities: [id], limit: 10 })),
};

const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** The standard scenario: "Blade Runner" (exact) × "Vangelis" (ambiguous → H2). */
export async function standardFixtures(lib: FixtureLibrary) {
  await lib.put(
    call.describe("Blade Runner", "movie"),
    describePayload("Blade Runner", {
      id: "M-BR",
      name: "Blade Runner",
      type: "urn:entity:movie",
    }),
  );
  await lib.put(
    call.describe("Vangelis", "artist"),
    describePayload(
      "Vangelis",
      { id: "A-VAN-LIVE", name: "Vangelis (Live)", type: "urn:entity:artist" },
      [{ id: "A-VAN", name: "Vangelis", type: "urn:entity:artist" }],
    ),
  );
  // Discovery threads (limit 10). B5–B10 and P3–P6 co-occur in both seeds' threads.
  const threads: [string, string, string[]][] = [
    ["M-BR", "artist", range("AR", 1, 10)],
    ["M-BR", "book", range("B", 1, 10)],
    ["M-BR", "place", range("P", 1, 10)],
    ["A-VAN", "book", range("B", 5, 14)],
    ["A-VAN", "movie", ["M-BR", ...range("MV", 1, 9)]],
    ["A-VAN", "place", range("P", 3, 12)],
  ];
  for (const [seed, target, ids] of threads)
    await lib.put(
      call.recommend({ targetType: target, signals: [seed], limit: 10 }),
      rankedPayload("recommend", target, ids),
    );
  // Tags (CI-5): seeds and every thread item; shared tags create tag bridges.
  const all = new Set([
    "M-BR",
    "A-VAN",
    ...threads.flatMap(([, , ids]) => ids),
  ]);
  for (const id of all) {
    const n = Number(id.replace(/\D/g, "") || "0");
    await lib.put(
      call.entityTags(id),
      tagsPayload([
        [`noir-${n % 3}`, "genre:media"],
        [`synth-${n % 4}`, "keyword:media"],
        [`own-${id}`, "keyword:media"],
      ]),
    );
  }
  // Evidence queries used by the scripted hypotheses.
  await lib.put(
    call.recommend({ targetType: "book", signals: ["M-BR"], limit: 20 }),
    rankedPayload("recommend", "book", ["B5", ...range("BX", 1, 19)]),
  );
  await lib.put(
    call.rank({
      options: ["B5", "B6", "B7"],
      optionType: "book",
      signals: ["A-VAN"],
    }),
    rankedPayload("rank", "book", ["B5", "B6", "B7"]),
  );
  await lib.put(
    call.compare({ groupA: ["M-BR"], groupB: ["A-VAN"] }),
    comparePayload([]),
  );
  await lib.put(
    call.recommend({ targetType: "place", signals: ["A-VAN"], limit: 20 }),
    rankedPayload("recommend", "place", ["P3", ...range("PX", 1, 19)]),
  );
}

// ---------------------------------------------------------------------------
// Scripted LLM (deterministic responders that read IDs from the untrusted input block)

export function inputOf(request: ProviderRequest): Record<string, unknown> {
  const text = request.messages[0]!.content;
  const json = text.slice(
    text.indexOf("<untrusted_input>") + 17,
    text.lastIndexOf("</untrusted_input>"),
  );
  return JSON.parse(json) as Record<string, unknown>;
}

type PoolElement = { entityId: string; name: string; domain: string | null };
const byName = (input: Record<string, unknown>, qlooName: string) => {
  const all = [
    ...((input.seeds as PoolElement[]) ?? []),
    ...((input.pool as { elements: PoolElement[] }[]) ?? []).flatMap(
      (p) => p.elements,
    ),
    ...((input.discovered as PoolElement[]) ?? []),
  ];
  const found = all.find((e) => e.name === qlooName);
  if (!found) throw new Error(`Scripted LLM: ${qlooName} not in pool`);
  return found.entityId;
};

export const INTENT_OUTPUT = {
  interests: [
    { text: "Blade Runner", guessedDomain: "movie", importance: 3 },
    { text: "Vangelis", guessedDomain: "artist", importance: 2 },
  ],
  targetDomains: ["book", "place", "artist", "movie"],
  venue: { type: "cafe" },
  constraints: {},
  goals: ["Attract new weekday visitors"],
  ambiguities: [{ interestIndex: 1, question: "Which Vangelis?" }],
  decisionSummary: "Two interests across film and music for a cafe night.",
};

export function scriptedExplorationLlm(): ScriptedLlmProvider {
  const provider = new ScriptedLlmProvider();
  provider.on("r1.intent", { output: INTENT_OUTPUT });
  provider.on("r3.generate", (request) => {
    const input = inputOf(request);
    const M = byName(input, "Blade Runner");
    const A = byName(input, "Vangelis");
    const [B5, B6, B7] = ["Fixture B5", "Fixture B6", "Fixture B7"].map((n) =>
      byName(input, n),
    );
    const P3 = byName(input, "Fixture P3");
    return {
      output: {
        hypotheses: [
          {
            tempId: "h1",
            title: "Neon noir reading lounge",
            premise:
              "Audiences of the film also show affinity for a shared set of novels.",
            elementRefs: [
              { entityId: M, role: "anchor" },
              { entityId: B5!, role: "accent" },
            ],
            claims: [
              {
                tempId: "c1",
                statement: "Film audiences show affinity for the anchor novel.",
                testKind: "CROSS_DOMAIN_AFFINITY",
                params: {
                  signalEntityIds: [M],
                  targetDomain: "book",
                  targetEntityId: B5,
                },
              },
              {
                tempId: "c2",
                statement:
                  "The novel leads a shortlist for the composer's audience.",
                testKind: "SHORTLIST_FIT",
                params: {
                  signalEntityIds: [A],
                  optionEntityIds: [B5, B6, B7],
                  targetEntityId: B5,
                },
              },
            ],
            creativeElements: [
              {
                text: "Rain-soundscape playlist",
                provenance: "CREATIVE_SPECULATION",
              },
            ],
            experienceSketch: "A dim reading lounge with synth ambience.",
          },
          {
            tempId: "h2",
            title: "Synth score supper",
            premise: "The film and composer audiences may share one evening.",
            elementRefs: [
              { entityId: A, role: "anchor" },
              { entityId: P3, role: "context" },
            ],
            claims: [
              {
                tempId: "c1",
                statement: "The two audiences overlap.",
                testKind: "AUDIENCE_BRIDGE",
                params: { signalEntityIds: [M], compareEntityIds: [A] },
              },
            ],
            creativeElements: [],
            experienceSketch: "A supper club scored live.",
          },
        ],
        decisionSummary: "Wove 2 hypotheses from the top bridges.",
      },
    };
  });
  const critique = (request: ProviderRequest) => {
    const input = inputOf(request) as {
      hypotheses: {
        hypothesisId: string;
        claims: { evidence: { evidenceId: string }[] }[];
      }[];
    };
    return {
      output: {
        perHypothesis: input.hypotheses.map((h) => {
          const cited = h.claims
            .flatMap((c) => c.evidence.map((e) => e.evidenceId))
            .slice(0, 2);
          return cited.length
            ? {
                hypothesisId: h.hypothesisId,
                confidenceNote: "Aggregate affinity checks agree.",
                citedEvidenceIds: cited,
                recommendation: "keep",
              }
            : {
                hypothesisId: h.hypothesisId,
                citedEvidenceIds: [],
                recommendation: "refine",
                refinementHint: "Test a place affinity instead.",
              };
        }),
        continueLoop: false,
        decisionSummary: "Reviewed hypotheses against their evidence.",
      },
    };
  };
  provider.on("r4.critique", critique, critique);
  provider.on("r3.revise", (request) => {
    const input = inputOf(request) as {
      hypotheses: { hypothesisId: string; title: string; status: string }[];
    } & Record<string, unknown>;
    const weak = input.hypotheses.find(
      (h) => h.title === "Synth score supper",
    )!;
    const A = byName(input, "Vangelis");
    const P3 = byName(input, "Fixture P3");
    return {
      output: {
        refined: [
          {
            revisionOfId: weak.hypothesisId,
            tempId: "h2r",
            title: "Synth score supper (venue test)",
            premise:
              "The composer's audience concentrates around a candidate venue type.",
            elementRefs: [
              { entityId: A, role: "anchor" },
              { entityId: P3, role: "context" },
            ],
            claims: [
              {
                tempId: "c1",
                statement: "Composer audiences show affinity for the venue.",
                testKind: "CROSS_DOMAIN_AFFINITY",
                params: {
                  signalEntityIds: [A],
                  targetDomain: "place",
                  targetEntityId: P3,
                },
              },
            ],
            creativeElements: [],
            experienceSketch: "A supper club in a candidate venue.",
          },
        ],
        retiredIds: [],
        spawned: [],
        decisionSummary:
          "Refined the inconclusive hypothesis to test a place affinity.",
      },
    };
  });
  return provider;
}

// ---------------------------------------------------------------------------
// Harness: database objects, runner deps, and a deterministic job drain

export const RUN_CONFIG = buildRunConfig({
  llmModel: "claude-opus-5-5",
  llmFallbackModel: "claude-sonnet-5-5",
  promptVersions: new PromptRegistry().versions(),
  harnessVersion: "fixture",
});

export const BRIEF = {
  title: "Film-and-music cafe night",
  challenge:
    "A small cafe wants a recurring evening that draws film and music fans midweek.",
  interests: [
    { text: "Blade Runner", domainHint: "movie" as const },
    { text: "Vangelis", domainHint: "artist" as const },
  ],
  venue: { type: "cafe" as const, capacity: 40 },
  constraints: { budgetBand: "low" as const },
  goals: ["Attract new weekday visitors"],
};

export async function seedProject(handle: DbHandle) {
  const workspace = await createWorkspace(handle.db, {
    secretHash: Math.random()
      .toString(16)
      .slice(2)
      .padEnd(64, "0")
      .slice(0, 64),
  });
  const project = await createProject(handle.db, {
    workspaceId: workspace.id,
    name: "Cafe nights",
    useCase: "cafe",
  });
  const brief = await withTx(handle.db, (tx) =>
    createBriefVersion(tx, { projectId: project.id, content: BRIEF }),
  );
  return { workspace, project, brief };
}

export function makeDeps(
  handle: DbHandle,
  boss: PgBoss,
  lib: FixtureLibrary,
  provider: ScriptedLlmProvider,
  overrides: Partial<RunnerDeps> & { ports?: Ports } = {},
): RunnerDeps {
  const qloo = createQlooAdapter(handle.db, {
    mode: "fixture",
    appEnv: "test",
    harnessVersion: "fixture",
    dailyLimit: 300,
    rateLimitPerMin: 10_000,
    fixtureRoot: lib.root,
  });
  const llm = createLlmGateway(
    {
      LLM_PROVIDER: "scripted",
      LLM_MODEL: "claude-opus-5-5",
      LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
      LLM_MODE: "standard",
    },
    createDbLlmRecorder(handle.db),
    provider,
  );
  return {
    handle,
    boss,
    ports: buildPorts(qloo, llm),
    cancelPollMs: 50,
    ...overrides,
  };
}

export async function startBoss(url: string): Promise<PgBoss> {
  const boss = createBoss(url, {
    role: "web",
    applicationName: "tessaloom-test-queue",
  });
  await boss.start();
  return boss;
}

/** Fetch and run queued steps until the queue is empty (or `max` steps ran). */
export async function drain(deps: RunnerDeps, max = 50) {
  const outcomes: Awaited<ReturnType<typeof runStep>>[] = [];
  for (let i = 0; i < max; i++) {
    const [job] = (await deps.boss.fetch<RunStepJob>(QUEUES.runStep, {
      includeMetadata: true,
    })) as JobWithMetadata<RunStepJob>[];
    if (!job) break;
    try {
      outcomes.push(
        await runStep(deps, job.data, {
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        }),
      );
      await deps.boss.complete(QUEUES.runStep, job.id);
    } catch (error) {
      await deps.boss.fail(QUEUES.runStep, job.id, {
        message: (error as Error).message,
      });
      throw error;
    }
  }
  return outcomes;
}
