import { expect, it, vi } from "vitest";
import { createScriptedDemoProvider } from "../../apps/worker/src/scripted-llm";
import {
  DeepSeekProvider,
  LlmGateway,
  deepseekReservationMicros,
  deepseekUsdPrices,
  PromptRegistry,
} from "../../packages/llm-gateway/src";
import {
  QUALITY_PLAN,
  generationCase,
  critiqueCase,
  validateGeneration,
  validateCritique,
} from "../fixtures/deepseek-quality";

it("dry-runs the exact two-case plan with scripted output, real schemas and semantic validators", async () => {
  const scripted = createScriptedDemoProvider();
  const baseline = new LlmGateway({
    provider: scripted,
    primaryModel: "scripted-demo",
    allowUnpricedModels: true,
  });
  const first = await baseline.generate({
    ...generationCase,
    ctx: { projectId: "offline" },
  });
  const second = await baseline.generate({
    ...critiqueCase,
    ctx: { projectId: "offline" },
  });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  const outputs = [
    first.ok ? first.value : null,
    second.ok ? second.value : null,
  ];
  const bodies: string[] = [];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      bodies.push(String(init!.body));
      return new Response(
        JSON.stringify({
          model: QUALITY_PLAN.model,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(outputs[bodies.length - 1]),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        }),
      );
    });
  const now = Date.parse("2026-10-23T10:00:00Z");
  const approval = {
    usdPerCny: QUALITY_PLAN.usdPerCny,
    verifiedAt: new Date(now).toISOString(),
  };
  const provider = new DeepSeekProvider({
    apiKey: "offline-sentinel",
    liveApproved: true,
    priceApproval: approval,
    maxRequests: 2,
    budgetCny: 2,
    fetch: fetcher,
    now: () => now,
  });
  const reserve = vi.fn(async () => ({
    ok: true as const,
    reservationId: "offline",
  }));
  const gateway = new LlmGateway({
    provider,
    primaryModel: QUALITY_PLAN.model,
    prices: deepseekUsdPrices(approval, now),
    spendGuard: { reserve, settle: async () => {} },
  });
  const ctx = {
    projectId: "offline",
    runId: "offline",
    inputOrigin: "synthetic" as const,
  };
  expect(await gateway.generate({ ...generationCase, ctx })).toMatchObject({
    ok: true,
    attempts: 1,
  });
  expect(await gateway.generate({ ...critiqueCase, ctx })).toMatchObject({
    ok: true,
    attempts: 1,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const body of bodies) {
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      QUALITY_PLAN.maxInputBytesPerRequest,
    );
    expect(JSON.parse(body)).toMatchObject({
      model: QUALITY_PLAN.model,
      max_output_tokens: 8192,
      text: { format: { type: "json_schema" } },
    });
  }
  expect(await gateway.generate({ ...generationCase, ctx })).toMatchObject({
    ok: false,
    attempts: 0,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (2 * deepseekReservationMicros(QUALITY_PLAN.model, 16384, 8192)) / 1e6,
  ).toBe(QUALITY_PLAN.estimatedReservationCny);
  // Safe to retain: exact rendered bodies contain only this fixture and public prompts.
  console.log(
    JSON.stringify({
      event: "deepseek_quality_plan_offline",
      requestBytes: bodies.map((b) => Buffer.byteLength(b)),
      promptVersions: new PromptRegistry().versions(),
      maximumRequests: 2,
      reservationCny: QUALITY_PLAN.estimatedReservationCny,
      reservationUsd: QUALITY_PLAN.estimatedReservationUsd,
    }),
  );
  if (first.ok) {
    const bad = structuredClone(first.value);
    bad.hypotheses[0]!.elementRefs[0]!.entityId =
      "99999999-9999-4999-8999-999999999999";
    expect(
      validateGeneration(bad).some((e) => e.code === "UNGROUNDED_ENTITY"),
    ).toBe(true);
  }
  if (second.ok) {
    const bad = structuredClone(second.value);
    bad.perHypothesis[0]!.citedEvidenceIds = [
      "99999999-9999-4999-8999-999999999999",
    ];
    expect(
      validateCritique(bad).some((e) => e.code === "UNKNOWN_CITATION"),
    ).toBe(true);
  }
});
