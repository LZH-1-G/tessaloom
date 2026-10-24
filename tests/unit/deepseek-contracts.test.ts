import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BlueprintDraft,
  ComparisonNarrative,
  CritiqueReport,
  HypothesisBatch,
  HypothesisRevision,
  IntentFrame,
} from "../../packages/core/src";
import {
  DeepSeekProvider,
  LlmGateway,
  PromptRegistry,
  deepseekUsdPrices,
} from "../../packages/llm-gateway/src";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const draft = {
  tempId: "h1",
  title: "Paper Lantern Listening Room",
  premise: "Pair invented book readings with invented music.",
  elementRefs: [
    { entityId: first, role: "anchor" },
    { entityId: second, role: "accent" },
  ],
  claims: [
    {
      tempId: "c1",
      statement: "Test shared affinity in synthetic data.",
      testKind: "CROSS_DOMAIN_AFFINITY",
      params: {
        signalEntityIds: [first],
        targetDomain: "artist",
        targetEntityId: second,
      },
    },
  ],
  creativeElements: [
    {
      text: "Let guests exchange handwritten listening notes.",
      provenance: "CREATIVE_SPECULATION",
    },
  ],
  experienceSketch: "A reading followed by a listening session.",
};
const summary = {
  decisionSummary: "Locally invented fixture, not a live model result.",
};
const contracts = [
  {
    id: "r1.intent",
    schema: IntentFrame,
    out: {
      interests: [
        { text: "Paper Atlas Stories", guessedDomain: "book", importance: 3 },
        { text: "Velvet Static Radio", guessedDomain: "artist", importance: 2 },
      ],
      targetDomains: ["book", "artist"],
      venue: { type: "cafe", capacity: 40 },
      constraints: { budgetBand: "low" },
      goals: [],
      ambiguities: [],
      ...summary,
    },
  },
  {
    id: "r3.generate",
    schema: HypothesisBatch,
    out: { hypotheses: [draft], ...summary },
  },
  {
    id: "r3.revise",
    schema: HypothesisRevision,
    out: {
      refined: [{ ...draft, revisionOfId: first }],
      retiredIds: [],
      spawned: [],
      ...summary,
    },
  },
  {
    id: "r4.critique",
    schema: CritiqueReport,
    out: {
      perHypothesis: [
        {
          hypothesisId: first,
          citedEvidenceIds: [],
          recommendation: "refine",
          refinementHint: "Avoid treating synthetic affinity as demand.",
        },
      ],
      continueLoop: false,
      ...summary,
    },
  },
  {
    id: "r5.compare",
    schema: ComparisonNarrative,
    out: {
      text: "The revised format emphasizes listening. No new data was retrieved.",
      citedEvidenceIds: [],
      ...summary,
    },
  },
  {
    id: "r6.compose",
    schema: BlueprintDraft,
    out: {
      title: "Paper Lantern Listening Room",
      concept: "An invented reading and listening format.",
      blocks: [
        {
          section: "programming",
          text: "Alternate readings with listening and discussion.",
          provenance: "CREATIVE_SPECULATION",
          evidenceIds: [],
        },
      ],
      mitigations: [],
      openQuestions: ["Which evening suits the venue?"],
      ...summary,
    },
  },
];
it.each(contracts)(
  "preserves $id contract with real schema and offline DeepSeek envelope",
  async ({ id, schema, out }) => {
    const now = Date.parse("2026-10-23T10:00:00Z");
    const approval = {
      usdPerCny: 0.2,
      verifiedAt: new Date(now).toISOString(),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-v4-pro",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: JSON.stringify(out) }],
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
        ),
    );
    const provider = new DeepSeekProvider({
      apiKey: "fake-sentinel",
      liveApproved: true,
      priceApproval: approval,
      maxRequests: 1,
      budgetCny: 2,
      fetch: fetcher,
      now: () => now,
    });
    const gateway = new LlmGateway({
      provider,
      primaryModel: "deepseek-v4-pro",
      prices: deepseekUsdPrices(approval, now),
      spendGuard: {
        reserve: async () => ({ ok: true, reservationId: "offline" }),
        settle: async () => {},
      },
    });
    const result = await gateway.generate({
      role: new PromptRegistry().get(id).role,
      promptId: id,
      input: {
        synthetic: true,
        entities: [
          { id: first, name: "Paper Atlas Stories" },
          { id: second, name: "Velvet Static Radio" },
        ],
      },
      schema: schema as z.ZodType,
      effort: "low",
      maxOutputTokens: 8192,
      ctx: { projectId: "offline", inputOrigin: "synthetic" },
    });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.instructions).toContain(new PromptRegistry().get(id).system);
    expect(body.text.format.schema.type).toBe("object");
  },
);
