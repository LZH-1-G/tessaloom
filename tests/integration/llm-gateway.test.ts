import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDbLlmRecorder,
  createLlmGateway,
} from "../../apps/worker/src/llm";
import {
  createProject,
  createWorkspace,
  sql,
  type Db,
} from "../../packages/db/src";
import { ScriptedLlmProvider } from "../../packages/llm-gateway/src";
import { createTestDatabase } from "./helpers/test-db";

let db: Db;
let drop: () => Promise<void>;
let projectId: string;

beforeAll(async () => {
  const test = await createTestDatabase();
  db = test.handle.db;
  drop = test.drop;
  const workspace = await createWorkspace(db, { secretHash: "b".repeat(64) });
  projectId = (
    await createProject(db, {
      workspaceId: workspace.id,
      name: "LLM",
      useCase: "cafe",
    })
  ).id;
});
afterAll(async () => {
  await drop?.();
});

const settings = {
  LLM_PROVIDER: "scripted" as const,
  LLM_MODEL: "claude-opus-5-5",
  LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
  LLM_MODE: "standard" as const,
};

describe("LLM invocation persistence", () => {
  it("persists the repair chain with provenance, cost, and no prompt text", async () => {
    const provider = new ScriptedLlmProvider().on(
      "r1.intent",
      { output: { answer: "" }, usage: { inputTokens: 100, outputTokens: 50 } },
      {
        output: { answer: "ok" },
        usage: { inputTokens: 200, outputTokens: 60, cachedInputTokens: 900 },
      },
    );
    const gateway = createLlmGateway(
      settings,
      createDbLlmRecorder(db),
      provider,
    )!;
    const result = await gateway.generate({
      role: "R1",
      promptId: "r1.intent",
      input: { brief: "SECRET-BRIEF-TEXT for a cafe" },
      inputExcerpt: { briefVersionId: "v1", interestCount: 2 },
      schema: z.object({ answer: z.string().min(1) }),
      effort: "low",
      maxOutputTokens: 1000,
      ctx: { projectId },
    });
    expect(result.ok).toBe(true);
    expect(result.invocationIds).toHaveLength(2);

    const rows = await db.execute<Record<string, unknown>>(
      sql`SELECT id, role, prompt_id, prompt_version, provider, model_id, fallback_used, effort, input_hash,
                 input_excerpt, output, validation_status, validation_errors, repair_of_id, stop_reason,
                 input_tokens, cached_input_tokens, output_tokens, estimated_cost_usd
          FROM llm_invocations WHERE project_id = ${projectId} ORDER BY created_at, id`,
    );
    expect(rows.rows).toHaveLength(2);
    const [invalid, repaired] = rows.rows;
    expect(invalid).toMatchObject({
      role: "R1",
      prompt_id: "r1.intent",
      provider: "scripted",
      model_id: "claude-opus-5-5",
      fallback_used: false,
      effort: "low",
      validation_status: "INVALID",
      repair_of_id: null,
      stop_reason: "end_turn",
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: "0.0014",
    });
    expect((invalid!.validation_errors as { code: string }[])[0]!.code).toBe(
      "SCHEMA",
    );
    expect(repaired).toMatchObject({
      validation_status: "REPAIRED",
      repair_of_id: invalid!.id,
      output: { answer: "ok" },
      cached_input_tokens: 900,
      estimated_cost_usd: "0.0022",
    });
    expect(repaired!.input_hash).toBe(invalid!.input_hash);
    expect(invalid!.prompt_version).toMatch(/^1\.0\.0\+[0-9a-f]{12}$/);
    expect(JSON.stringify(rows.rows)).not.toContain("SECRET-BRIEF-TEXT");
    expect(invalid!.input_excerpt).toEqual({
      briefVersionId: "v1",
      interestCount: 2,
    });
  });

  it("returns no gateway for the anthropic provider without a key", () => {
    expect(
      createLlmGateway(
        { ...settings, LLM_PROVIDER: "anthropic" },
        createDbLlmRecorder(db),
      ),
    ).toBeNull();
  });
});
