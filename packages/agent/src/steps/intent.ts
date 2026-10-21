import { IntentFrame } from "@tessaloom/core";
import { safeUseValidator } from "../validators";
import { MAX_OUTPUT, base, failLlm, llmCall, truncate } from "./common";
import type { Ports, StepContext, StepResult } from "./types";

/** R1 (AGENT_WORKFLOW §2): brief → IntentFrame, then gate H1. */
export async function analyzeIntent(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("INTENT_READY");
  const result = await llmCall(ctx, ports, acc, {
    role: "R1",
    promptId: "r1.intent",
    label: "R1 intent analysis",
    input: { brief: ctx.brief.content },
    inputExcerpt: {
      briefVersionId: ctx.brief.versionId,
      interestCount: ctx.brief.content.interests.length,
    },
    schema: IntentFrame,
    maxOutputTokens: MAX_OUTPUT.R1,
    validate: (frame) => [
      ...safeUseValidator(frame),
      // The frame must describe the brief's interests, one-to-one and in order.
      ...(frame.interests.length !== ctx.brief.content.interests.length
        ? [
            {
              code: "INTEREST_COUNT",
              path: "interests",
              message: `Expected ${ctx.brief.content.interests.length} interests in the brief's order`,
            },
          ]
        : []),
      ...frame.ambiguities
        .filter((a) => a.interestIndex >= frame.interests.length)
        .map((a) => ({
          code: "AMBIGUITY_INDEX",
          path: "ambiguities",
          message: `Interest index ${a.interestIndex} does not exist`,
        })),
    ],
  });
  if (!result.ok) return failLlm(result, "R1 intent analysis", acc);
  acc.commit.intent = {
    briefVersionId: ctx.brief.versionId,
    intentFrame: result.value,
    llmInvocationId: result.invocationIds.at(-1)!,
  };
  acc.guard = { intentValid: true };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R1",
    summary: truncate(result.value.decisionSummary),
  });
  acc.pendingConfirmation = {
    kind: "BRIEF",
    briefVersionId: ctx.brief.versionId,
  };
  return acc;
}
