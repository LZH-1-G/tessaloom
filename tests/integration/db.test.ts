import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGETS,
  DEFAULT_SCORING_WEIGHTS,
  type ExperimentDefinition,
  ExperimentVariables,
  type EnvelopeSummary,
  uuidv7,
} from "../../packages/core/src";
import {
  DomainRuleError,
  NotFoundError,
  StateConflictError,
  addBlueprintRevision,
  appendRunEvents,
  consumeWithinLimit,
  createBlueprint,
  createBranch,
  createBriefVersion,
  createOrGetExperiment,
  createProject,
  createResolution,
  createRun,
  createShareLink,
  createWorkspace,
  findActiveShareLink,
  getProject,
  getRun,
  insertEvidence,
  insertHypothesis,
  listRunEventsAfter,
  recordLlmInvocation,
  recordResolutionCandidates,
  recordSnapshot,
  recordToolInvocation,
  revokeShareLink,
  selectResolutionCandidate,
  transitionRun,
  upsertCulturalEntity,
  sql,
  withTx,
  type Db,
} from "../../packages/db/src";
import { createTestDatabase } from "./helpers/test-db";

/** Drizzle wraps Postgres errors; assert on the original message (and SQLSTATE) in `cause`. */
async function expectDbError(
  promise: Promise<unknown>,
  pattern: RegExp,
  sqlState?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the database to reject the statement");
    },
    (e: unknown) =>
      e as { message?: string; cause?: { message?: string; code?: string } },
  );
  const message = error.cause?.message ?? error.message ?? "";
  expect(message).toMatch(pattern);
  if (sqlState) expect(error.cause?.code).toBe(sqlState);
}

let db: Db;
let drop: () => Promise<void>;

const brief = {
  title: "Midnight Margins",
  challenge:
    "A late-evening reading event for people who rarely visit bookstores.",
  interests: [{ text: "Japanese city pop" }, { text: "Nordic noir" }],
  venue: { type: "bookstore", capacity: 60 },
};
const config = {
  llmModel: "claude-opus-5-5",
  llmFallbackModel: "claude-sonnet-5-5",
  effortByRole: {
    R1: "low",
    R2: "low",
    R3: "high",
    R4: "high",
    R5: "medium",
    R6: "medium",
  },
  promptVersions: {},
  qlooAdapterVersion: "0.1.0",
  harnessVersion: "0.1.26",
  evaluationRulesetVersion: "2026-10-21.v1",
};
const okSummary: EnvelopeSummary = {
  status: "ok",
  shape: "result_list",
  resultCount: 3,
  errorCode: null,
  retryable: null,
};

function definition(seedId: string, tension = 0.5): ExperimentDefinition {
  return {
    schemaVersion: 1,
    briefContentHash: "b".repeat(64),
    seeds: [{ qlooId: seedId, kind: "entity", role: "seed" }],
    variables: ExperimentVariables.parse({
      targetDomains: ["movie"],
      collisionTension: tension,
    }),
    scoringWeights: DEFAULT_SCORING_WEIGHTS,
    budgets: DEFAULT_BUDGETS.EXPLORATION,
    versions: {
      evaluationRuleset: "r1",
      promptSet: "p1",
      qlooAdapter: "0.1.0",
      harness: "0.1.26",
      llmModel: "claude-opus-5-5",
    },
    parentExperimentKey: null,
    variableDelta: null,
  };
}

async function seedProject() {
  const workspace = await createWorkspace(db, {
    secretHash: uuidv7().replace(/-/g, "").padEnd(64, "0"),
  });
  const project = await createProject(db, {
    workspaceId: workspace.id,
    name: "Test",
    useCase: "bookstore",
  });
  const briefVersion = await withTx(db, (tx) =>
    createBriefVersion(tx, { projectId: project.id, content: brief }),
  );
  return { workspace, project, briefVersion };
}

async function seedRunContext() {
  const { workspace, project, briefVersion } = await seedProject();
  const { experiment } = await withTx(db, (tx) =>
    createOrGetExperiment(tx, {
      projectId: project.id,
      briefVersionId: briefVersion.id,
      definition: definition(uuidv7()),
      mode: "live",
    }),
  );
  const run = await createRun(db, {
    experimentId: experiment.id,
    kind: "EXPLORATION",
    budget: DEFAULT_BUDGETS.EXPLORATION,
    config,
  });
  const llm = await recordLlmInvocation(db, {
    projectId: project.id,
    runId: run.id,
    role: "R3",
    promptId: "hypothesis.generate",
    promptVersion: "1.0.0",
    provider: "scripted",
    modelId: "scripted",
    effort: "high",
    inputHash: "c".repeat(64),
    inputExcerpt: {},
    validationStatus: "VALID",
  });
  const entityA = await upsertCulturalEntity(db, {
    workspaceId: workspace.id,
    kind: "entity",
    qlooId: "Q-A",
    name: "A",
    snapshot: {},
    provenanceClass: "QLOO_SOURCED",
  });
  const entityB = await upsertCulturalEntity(db, {
    workspaceId: workspace.id,
    kind: "entity",
    qlooId: "Q-B",
    name: "B",
    snapshot: {},
    provenanceClass: "QLOO_SOURCED",
  });
  const { hypothesis, claims } = await withTx(db, (tx) =>
    insertHypothesis(tx, {
      experimentId: experiment.id,
      runId: run.id,
      llmInvocationId: llm.id,
      iteration: 0,
      title: "City-pop reading lounge",
      premise: "Premise",
      experienceSketch: "Sketch",
      scoringVersion: "s1",
      elements: [
        { entityId: entityA.id, role: "anchor" },
        { entityId: entityB.id, role: "accent" },
      ],
      claims: [
        {
          statement: "Fans of A favor B-type films.",
          testKind: "CROSS_DOMAIN_AFFINITY",
          testParams: {},
        },
      ],
    }),
  );
  return { workspace, project, experiment, run, hypothesis, claim: claims[0]! };
}

async function invocation(projectId: string, dataOrigin: "LIVE" | "FIXTURE") {
  return recordToolInvocation(db, {
    projectId,
    purpose: "test",
    method: "recommend",
    workflow: "qloo_recommend",
    transport: dataOrigin === "FIXTURE" ? "FIXTURE" : "HARNESS_CLI",
    argsRedacted: { target_type: "movie" },
    requestHash: "d".repeat(64),
    dataOrigin,
    summary: okSummary,
  });
}

beforeAll(async () => {
  const test = await createTestDatabase();
  db = test.handle.db;
  drop = test.drop;
});
afterAll(async () => {
  await drop?.();
});

describe("migrations and schema", () => {
  it("creates every documented table", async () => {
    const result = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '__drizzle%'`,
    );
    expect(Number(result.rows[0]!.count)).toBe(28);
  });
});

describe("brief versions", () => {
  it("assigns gap-free unique versions under concurrent writers and moves the pointer", async () => {
    const { project } = await seedProject();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withTx(db, (tx) =>
          createBriefVersion(tx, { projectId: project.id, content: brief }),
        ),
      ),
    );
    const rows = await db.execute<{ version: number }>(
      sql`SELECT version FROM brief_versions WHERE project_id = ${project.id} ORDER BY version`,
    );
    expect(rows.rows.map((r) => r.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const pointer = await db.execute<{ version: number }>(sql`
      SELECT b.version FROM projects p JOIN brief_versions b ON b.id = p.current_brief_version_id WHERE p.id = ${project.id}`);
    expect(pointer.rows[0]!.version).toBe(9);
  });
  it("rejects invalid brief content before writing", async () => {
    const { project } = await seedProject();
    await expect(
      withTx(db, (tx) =>
        createBriefVersion(tx, {
          projectId: project.id,
          content: { ...brief, interests: [] },
        }),
      ),
    ).rejects.toThrow();
  });
  it("enforces the deferred current-version foreign key at commit", async () => {
    const { project } = await seedProject();
    await expect(
      withTx(db, async (tx) => {
        await tx.execute(
          sql`UPDATE projects SET current_brief_version_id = ${uuidv7()} WHERE id = ${project.id}`,
        );
      }),
    ).rejects.toThrow();
  });
});

describe("workspace scoping", () => {
  it("hides projects from other workspaces", async () => {
    const { project } = await seedProject();
    const other = await createWorkspace(db, { secretHash: "e".repeat(64) });
    await expect(getProject(db, other.id, project.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("experiments", () => {
  it("returns the existing experiment for an identical definition (deterministic key)", async () => {
    const { project, briefVersion } = await seedProject();
    const def = definition("SEED-1");
    const first = await withTx(db, (tx) =>
      createOrGetExperiment(tx, {
        projectId: project.id,
        briefVersionId: briefVersion.id,
        definition: def,
        mode: "live",
      }),
    );
    const second = await withTx(db, (tx) =>
      createOrGetExperiment(tx, {
        projectId: project.id,
        briefVersionId: briefVersion.id,
        definition: def,
        mode: "live",
      }),
    );
    const third = await withTx(db, (tx) =>
      createOrGetExperiment(tx, {
        projectId: project.id,
        briefVersionId: briefVersion.id,
        definition: definition("SEED-1", 0.8),
        mode: "live",
      }),
    );
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({
      reused: true,
      experiment: { id: first.experiment.id },
    });
    expect(third.experiment.id).not.toBe(first.experiment.id);
    expect(first.experiment.rootExperimentId).toBe(first.experiment.id);
  });
  it("creates branches that inherit the root and record the variable delta", async () => {
    const { project, briefVersion } = await seedProject();
    const root = await withTx(db, (tx) =>
      createOrGetExperiment(tx, {
        projectId: project.id,
        briefVersionId: briefVersion.id,
        definition: definition("ROOT"),
        mode: "live",
      }),
    );
    const branch = await withTx(db, (tx) =>
      createBranch(tx, {
        projectId: project.id,
        briefVersionId: briefVersion.id,
        definition: definition("ROOT", 0.8),
        mode: "live",
        parentExperimentId: root.experiment.id,
        variableDelta: { collisionTension: 0.8 },
        branchMode: "hold_hypotheses",
        plannedDirtyQueries: 0,
        plannedReusedQueries: 4,
      }),
    );
    expect(branch.experiment).toMatchObject({
      kind: "BRANCH",
      parentExperimentId: root.experiment.id,
      rootExperimentId: root.experiment.id,
    });
    const rows = await db.execute(
      sql`SELECT * FROM counterfactual_branches WHERE branch_experiment_id = ${branch.experiment.id}`,
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe("runs and events", () => {
  it("allows exactly one of two concurrent transitions from the same version", async () => {
    const { run } = await seedRunContext();
    const results = await Promise.allSettled([
      transitionRun(db, {
        runId: run.id,
        expectedStateVersion: 0,
        to: "ANALYZING_INTENT",
      }),
      transitionRun(db, {
        runId: run.id,
        expectedStateVersion: 0,
        to: "CANCELLED",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StateConflictError);
    expect((await getRun(db, run.id)).stateVersion).toBe(1);
  });
  it("keeps event sequence numbers contiguous under concurrent appends", async () => {
    const { run } = await seedRunContext();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withTx(db, (tx) =>
          appendRunEvents(
            tx,
            run.id,
            [0, 1, 2].map((j) => ({
              type: "DECISION_SUMMARY",
              state: "QUEUED" as const,
              summary: `w${i}-${j}`,
            })),
          ),
        ),
      ),
    );
    const events = await listRunEventsAfter(db, run.id);
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    expect(
      (await listRunEventsAfter(db, run.id, 10)).map((e) => e.seq),
    ).toEqual([11, 12, 13, 14, 15]);
  });
  it("makes run events append-only", async () => {
    const { run } = await seedRunContext();
    await withTx(db, (tx) =>
      appendRunEvents(tx, run.id, [
        { type: "RUN_STARTED", state: "QUEUED", summary: "started" },
      ]),
    );
    await expectDbError(
      db.execute(
        sql`UPDATE run_events SET summary = 'rewritten' WHERE run_id = ${run.id}`,
      ),
      /append-only/,
      "23001",
    );
  });
});

describe("evidence provenance", () => {
  it("rejects Qloo-sourced evidence without a tool invocation", async () => {
    const { experiment, run, hypothesis, claim } = await seedRunContext();
    await expect(
      insertEvidence(db, {
        claimId: claim.id,
        hypothesisId: hypothesis.id,
        experimentId: experiment.id,
        runId: run.id,
        toolInvocationId: null,
        stance: "SUPPORTS",
        evaluatorId: "e",
        rulesetVersion: "r",
        facts: [],
        primaryMeasure: "AUDIENCE_AFFINITY",
        quality: "FULL",
        provenanceClass: "QLOO_SOURCED",
      }),
    ).rejects.toThrow();
  });
  it("never labels fixture-derived evidence as Qloo data, and vice versa", async () => {
    const { project, experiment, run, hypothesis, claim } =
      await seedRunContext();
    const base = {
      claimId: claim.id,
      hypothesisId: hypothesis.id,
      experimentId: experiment.id,
      runId: run.id,
      stance: "SUPPORTS" as const,
      evaluatorId: "e",
      rulesetVersion: "r",
      facts: [],
      primaryMeasure: "AUDIENCE_AFFINITY" as const,
      quality: "FULL" as const,
    };
    const fixture = await invocation(project.id, "FIXTURE");
    const live = await invocation(project.id, "LIVE");
    await expectDbError(
      insertEvidence(db, {
        ...base,
        toolInvocationId: fixture.id,
        provenanceClass: "QLOO_SOURCED",
      }),
      /FIXTURE/,
      "23514",
    );
    await expectDbError(
      insertEvidence(db, {
        ...base,
        toolInvocationId: live.id,
        provenanceClass: "DEVELOPMENT_FIXTURE",
      }),
      /FIXTURE/,
      "23514",
    );
    await expect(
      insertEvidence(db, {
        ...base,
        toolInvocationId: fixture.id,
        provenanceClass: "DEVELOPMENT_FIXTURE",
      }),
    ).resolves.toBeTruthy();
  });
  it("rejects model-sourced stances and untyped facts; keeps evidence immutable", async () => {
    const { project, experiment, run, hypothesis, claim } =
      await seedRunContext();
    const live = await invocation(project.id, "LIVE");
    await expect(
      db.execute(sql`INSERT INTO evidence_records (id, claim_id, hypothesis_id, experiment_id, run_id, tool_invocation_id, stance, evaluator_id, ruleset_version, facts, primary_measure, quality, provenance_class)
        VALUES (${uuidv7()}, ${claim.id}, ${hypothesis.id}, ${experiment.id}, ${run.id}, ${live.id}, 'SUPPORTS', 'e', 'r', '[]', 'AUDIENCE_AFFINITY', 'FULL', 'MODEL_INTERPRETATION')`),
    ).rejects.toThrow();
    await expect(
      insertEvidence(db, {
        claimId: claim.id,
        hypothesisId: hypothesis.id,
        experimentId: experiment.id,
        runId: run.id,
        toolInvocationId: live.id,
        stance: "SUPPORTS",
        evaluatorId: "e",
        rulesetVersion: "r",
        facts: [
          {
            statement: "s",
            jsonPointer: "/results/0/affinity",
            value: 0.9,
            measure: "CREATIVE_FIT" as never,
            verifiedAtIngest: true,
          },
        ],
        primaryMeasure: "AUDIENCE_AFFINITY",
        quality: "FULL",
        provenanceClass: "QLOO_SOURCED",
      }),
    ).rejects.toThrow();
    const record = await insertEvidence(db, {
      claimId: claim.id,
      hypothesisId: hypothesis.id,
      experimentId: experiment.id,
      runId: run.id,
      toolInvocationId: live.id,
      stance: "INSUFFICIENT",
      evaluatorId: "e",
      rulesetVersion: "r",
      facts: [],
      primaryMeasure: "TREND",
      quality: "UNSUPPORTED",
      provenanceClass: "QLOO_SOURCED",
    });
    await expectDbError(
      db.execute(
        sql`UPDATE evidence_records SET stance = 'SUPPORTS' WHERE id = ${record.id}`,
      ),
      /append-only/,
      "23001",
    );
    await expectDbError(
      db.execute(
        sql`UPDATE tool_invocations SET result_count = 99 WHERE id = ${live.id}`,
      ),
      /append-only/,
      "23001",
    );
  });
});

describe("Qloo snapshots (raw retention off by default)", () => {
  it("stores only the structural summary unless retention is explicitly on", async () => {
    const common = {
      requestHash: "f".repeat(64),
      workflow: "qloo_recommend",
      transport: "HARNESS_CLI" as const,
      harnessVersion: "0.1.26",
      summary: okSummary,
      retrievedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      isFixture: false,
      raw: { results: [1] },
    };
    const off = await recordSnapshot(db, common);
    expect(off).toMatchObject({
      rawRetained: false,
      raw: null,
      rawBytes: null,
      envelopeShape: "result_list",
    });
    const on = await recordSnapshot(db, { ...common, rawRetention: "on" });
    expect(on.rawRetained).toBe(true);
    await expect(
      db.execute(
        sql`UPDATE qloo_response_snapshots SET raw = '{"x":1}' WHERE id = ${off.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`UPDATE qloo_response_snapshots SET pinned = true WHERE id = ${off.id}`,
      ),
    ).resolves.toBeTruthy();
  });
  it("requires a cache source exactly for CACHE invocations", async () => {
    const { project } = await seedProject();
    await expect(
      recordToolInvocation(db, {
        projectId: project.id,
        purpose: "p",
        method: "m",
        workflow: "w",
        transport: "HARNESS_CLI",
        argsRedacted: {},
        requestHash: "a".repeat(64),
        dataOrigin: "CACHE",
        summary: okSummary,
      }),
    ).rejects.toThrow();
  });
});

describe("entity resolution (V1 disambiguation)", () => {
  it("keeps all candidates, requires confirmation, and rejects unoffered selections", async () => {
    const { workspace, project } = await seedProject();
    const resolution = await createResolution(db, {
      projectId: project.id,
      inputText: "Murder on the Orient Express",
      requestedKind: "entity",
    });
    expect(resolution.status).toBe("PENDING");
    const recorded = await recordResolutionCandidates(db, {
      resolutionId: resolution.id,
      toolInvocationIds: [],
      candidates: {
        entities: [
          {
            qlooId: "ED-MINOR",
            name: "Murder on the Orient Express",
            popularity: 0.21,
            source: "selected",
            rankInSource: 0,
          },
          {
            qlooId: "ED-CANON",
            name: "Murder on the Orient Express (Hercule Poirot, #10)",
            popularity: 0.999,
            source: "alternative",
            rankInSource: 0,
          },
        ],
        tags: [],
        harnessSelectedQlooId: "ED-MINOR",
        provenance: [
          { strategy: "exact_name_context_or_choice", match: "exact" },
        ],
      },
    });
    expect(recorded.status).toBe("AMBIGUOUS");
    const canon = await upsertCulturalEntity(db, {
      workspaceId: workspace.id,
      kind: "entity",
      qlooId: "ED-CANON",
      name: "Canon",
      snapshot: {},
      provenanceClass: "QLOO_SOURCED",
    });
    const stranger = await upsertCulturalEntity(db, {
      workspaceId: workspace.id,
      kind: "entity",
      qlooId: "NOT-OFFERED",
      name: "X",
      snapshot: {},
      provenanceClass: "QLOO_SOURCED",
    });
    await expect(
      withTx(db, (tx) =>
        selectResolutionCandidate(tx, {
          resolutionId: resolution.id,
          entityId: stranger.id,
          method: "USER_SELECTED",
        }),
      ),
    ).rejects.toBeInstanceOf(DomainRuleError);
    await expect(
      withTx(db, (tx) =>
        selectResolutionCandidate(tx, {
          resolutionId: resolution.id,
          entityId: canon.id,
          method: "EXACT_SINGLE",
        }),
      ),
    ).rejects.toBeInstanceOf(DomainRuleError);
    const resolved = await withTx(db, (tx) =>
      selectResolutionCandidate(tx, {
        resolutionId: resolution.id,
        entityId: canon.id,
        method: "USER_SELECTED",
      }),
    );
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      selectedEntityId: canon.id,
    });
    expect(
      (resolved.candidates as { entities: unknown[] }).entities,
    ).toHaveLength(2);
  });
  it("rejects RESOLVED without a selection and fixture entities labelled as Qloo data", async () => {
    const { workspace, project } = await seedProject();
    const resolution = await createResolution(db, {
      projectId: project.id,
      inputText: "x",
      requestedKind: "tag",
    });
    await expect(
      db.execute(
        sql`UPDATE entity_resolution_records SET status = 'RESOLVED' WHERE id = ${resolution.id}`,
      ),
    ).rejects.toThrow();
    const fixture = await invocation(project.id, "FIXTURE");
    await expectDbError(
      upsertCulturalEntity(db, {
        workspaceId: workspace.id,
        kind: "entity",
        qlooId: "fixture-1",
        name: "F",
        snapshot: {},
        provenanceClass: "QLOO_SOURCED",
        sourceToolInvocationId: fixture.id,
      }),
      /FIXTURE/,
      "23514",
    );
  });
});

describe("quota counters", () => {
  it("never exceeds the limit under concurrent consumption", async () => {
    const scopeId = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumeWithinLimit(db, {
          scope: "global",
          scopeId,
          metric: "qloo_calls",
          limit: 7,
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(7);
    expect(Math.max(...results.filter((r): r is number => r !== null))).toBe(7);
  });
});

describe("blueprints and share links", () => {
  const content = {
    title: "T",
    format: "event" as const,
    concept: "C",
    sections: [],
    constraintsIdentified: [],
    openQuestions: [],
  };
  it("creates append-only revisions with optimistic concurrency", async () => {
    const { project, experiment, hypothesis } = await seedRunContext();
    const blueprint = await createBlueprint(db, {
      projectId: project.id,
      experimentId: experiment.id,
      hypothesisIds: [hypothesis.id],
      format: "event",
    });
    const first = await withTx(db, (tx) =>
      addBlueprintRevision(tx, {
        blueprintId: blueprint.id,
        baseRevisionId: null,
        author: "USER",
        content,
        traceabilityReport: {},
      }),
    );
    await expect(
      withTx(db, (tx) =>
        addBlueprintRevision(tx, {
          blueprintId: blueprint.id,
          baseRevisionId: null,
          author: "USER",
          content,
          traceabilityReport: {},
        }),
      ),
    ).rejects.toBeInstanceOf(StateConflictError);
    const second = await withTx(db, (tx) =>
      addBlueprintRevision(tx, {
        blueprintId: blueprint.id,
        baseRevisionId: first.id,
        author: "USER",
        content,
        traceabilityReport: {},
      }),
    );
    expect(second.revisionNumber).toBe(2);
    await expectDbError(
      db.execute(
        sql`UPDATE blueprint_revisions SET change_summary = 'x' WHERE id = ${first.id}`,
      ),
      /append-only/,
      "23001",
    );
    await expect(
      withTx(db, (tx) =>
        addBlueprintRevision(tx, {
          blueprintId: blueprint.id,
          baseRevisionId: second.id,
          author: "AGENT",
          content,
          traceabilityReport: {},
        }),
      ),
    ).rejects.toThrow();
  });
  it("finds only active, unexpired share links by token hash", async () => {
    const { project } = await seedProject();
    const active = await createShareLink(db, {
      projectId: project.id,
      scope: "project",
      targetId: project.id,
      tokenHash: "1".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await createShareLink(db, {
      projectId: project.id,
      scope: "project",
      targetId: project.id,
      tokenHash: "2".repeat(64),
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await findActiveShareLink(db, "1".repeat(64))).toMatchObject({
      id: active.id,
    });
    expect(await findActiveShareLink(db, "2".repeat(64))).toBeNull();
    await revokeShareLink(db, {
      shareLinkId: active.id,
      projectId: project.id,
    });
    expect(await findActiveShareLink(db, "1".repeat(64))).toBeNull();
  });
});
