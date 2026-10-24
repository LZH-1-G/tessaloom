/** Local-only ledger preparation. No model provider is constructed here. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createTestDatabase } from "../integration/helpers/test-db";
import {
  createWorkspace,
  createProject,
  createBriefVersion,
  withTx,
  createDemoGrant,
  redeemDemoGrant,
  createOrGetExperiment,
  createRun,
} from "../../packages/db/src";
import { ExperimentDefinition } from "../../packages/core/src";
import { buildRunConfig } from "../../apps/worker/src/compose";
import { PromptRegistry } from "../../packages/llm-gateway/src";
import { generationInput, QUALITY_PLAN } from "../fixtures/deepseek-quality";
const output = process.argv[2];
assert(output && output.startsWith("/private/tmp/tessaloom-deepseek-"));
const test = await createTestDatabase();
try {
  const config = buildRunConfig({
    llmModel: QUALITY_PLAN.model,
    llmFallbackModel: QUALITY_PLAN.model,
    promptVersions: new PromptRegistry().versions(),
    harnessVersion: "synthetic-quality-v1",
  });
  const budget = {
    maxIterations: 0,
    maxHypotheses: 2,
    maxClaimsPerHypothesis: 3,
    maxQlooCalls: 0,
    maxLlmCalls: 2,
    maxLlmOutputTokens: 16384,
    maxEstimatedCostUsd: 0.4,
    wallClockSeconds: 180,
  };
  const ids = await withTx(test.handle.db, async (tx) => {
    const workspace = await createWorkspace(tx, {
      secretHash: randomBytes(32).toString("hex"),
    });
    const project = await createProject(tx, {
      workspaceId: workspace.id,
      name: "Authorized synthetic DeepSeek quality trial",
      useCase: "cafe",
    });
    const brief = await createBriefVersion(tx, {
      projectId: project.id,
      content: {
        ...generationInput.brief,
        interests: [
          { text: "Paper Atlas Stories", domainHint: "book" },
          { text: "Velvet Static Radio", domainHint: "artist" },
        ],
      },
    });
    const codeHash = randomBytes(32).toString("hex");
    const grant = await createDemoGrant(tx, {
      label: "One bounded synthetic trial",
      codeHash,
      expiresAt: new Date(Date.now() + 3600000),
      maxRuns: 1,
      maxLlmUsd: 0.4,
    });
    assert(await redeemDemoGrant(tx, workspace.id, codeHash));
    const definition = ExperimentDefinition.parse({
      schemaVersion: 1,
      briefContentHash: brief.contentHash,
      seeds: [],
      variables: { targetDomains: ["book", "artist", "movie"] },
      scoringWeights: { support: 0.4, novelty: 0.35, feasibility: 0.25 },
      budgets: budget,
      versions: {
        evaluationRuleset: config.evaluationRulesetVersion,
        promptSet: "synthetic-quality-v1",
        qlooAdapter: config.qlooAdapterVersion,
        harness: config.harnessVersion,
        llmModel: QUALITY_PLAN.model,
      },
      parentExperimentKey: null,
      variableDelta: null,
    });
    const { experiment } = await createOrGetExperiment(tx, {
      projectId: project.id,
      briefVersionId: brief.id,
      definition,
      mode: "fixture",
    });
    const run = await createRun(tx, {
      experimentId: experiment.id,
      kind: "EXPLORATION",
      budget,
      config,
      admission: {
        access: "invite",
        maxActivePerWorkspace: 1,
        maxWorkingGlobal: 1,
        dailyRunsPerWorkspace: 1,
      },
    });
    return {
      projectId: project.id,
      runId: run.id,
      grantId: grant.id,
      experimentId: experiment.id,
    };
  });
  const url = new URL(test.url);
  url.hostname = "host.docker.internal";
  writeFileSync(
    output,
    JSON.stringify({ databaseUrl: url.toString(), ...ids }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      event: "trial_ledger_prepared",
      ...ids,
      budget,
      databasePreserved: true,
    }),
  );
} finally {
  await test.handle.close();
}
