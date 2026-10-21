import type { GuardContext, RunEventName } from "@tessaloom/core";
import type { z } from "zod";
import { remaining } from "../budget";
import type { LlmResult, QlooProvenanceLike, QlooResult } from "../ports";
import type { ValidationIssue } from "../validators";
import type { Ports, Provenance, StepContext, StepResult } from "./types";

export const INSIGHT = new Set([
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
]);
/** Accepted by name-resolving tools only (V1). Labeled as legacy types. */
export const LEGACY = new Set(["actor", "album", "author", "director"]);

export const MAX_OUTPUT = { R1: 4000, R3: 12000, R4: 6000 } as const;

export const truncate = (s: string, n = 280) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/** `urn:entity:book` → `book`; `urn:tag:…` → `tag`. */
export function domainFromType(type?: string | null): string | null {
  if (!type) return null;
  if (type.startsWith("urn:tag")) return "tag";
  const m = /^urn:entity:([a-z_]+)$/.exec(type);
  return m ? m[1]! : null;
}

export const provenanceOf = (
  p: QlooProvenanceLike | null | undefined,
): Provenance =>
  p?.dataOrigin === "FIXTURE" ? "DEVELOPMENT_FIXTURE" : "QLOO_SOURCED";

export function base(
  event: RunEventName,
  guard: GuardContext = {},
): StepResult {
  return { event, guard, commit: {}, events: [], usage: {} };
}

export function fatal(
  code: string,
  message: string,
  extra: Partial<StepResult> = {},
): StepResult {
  return {
    ...base("FATAL_ERROR"),
    terminalReason: code,
    error: { code, message },
    ...extra,
  };
}

export class Cancelled extends Error {}

export function failLlm(
  result: Extract<LlmResult<unknown>, { ok: false }>,
  label: string,
  acc: StepResult,
): StepResult {
  const carry = { events: acc.events, usage: acc.usage, commit: acc.commit };
  switch (result.reason) {
    case "BUDGET":
      return {
        ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
        ...carry,
        terminalReason: "BUDGET:LLM",
      };
    case "CANCELLED":
      return { ...base("CANCEL"), ...carry, terminalReason: "USER_CANCELLED" };
    case "REFUSED":
      return fatal(
        "LLM_REFUSED",
        "The model declined this request. Try rephrasing the brief.",
        carry,
      );
    case "TRUNCATED":
      return fatal(
        "LLM_OUTPUT_TRUNCATED",
        `${label}: output exceeded its length limit`,
        carry,
      );
    case "INVALID_OUTPUT":
      return fatal(
        "LLM_INVALID_OUTPUT",
        `${label}: output failed validation after one repair`,
        carry,
      );
    case "UNAVAILABLE":
      return fatal(
        "LLM_UNAVAILABLE",
        `${label}: the model provider is unavailable`,
        { ...carry, transient: true },
      );
    case "CONFIGURATION":
      return fatal(
        "LLM_NOT_CONFIGURED",
        `${label}: the LLM provider is not configured`,
        carry,
      );
  }
}

/** Shared LLM call: budget context, usage accounting, and activity events. */
export async function llmCall<S extends z.ZodType>(
  ctx: StepContext,
  ports: Ports,
  acc: StepResult,
  req: {
    role: "R1" | "R3" | "R4" | "R5" | "R6";
    promptId: string;
    label: string;
    input: unknown;
    inputExcerpt?: Record<string, unknown>;
    schema: S;
    maxOutputTokens: number;
    validate?: (value: z.output<S>) => ValidationIssue[];
  },
): Promise<LlmResult<z.output<S>>> {
  if (!ports.llm)
    return {
      ok: false,
      reason: "CONFIGURATION",
      invocationIds: [],
      modelId: null,
      fallbackUsed: false,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      costUsd: 0,
      attempts: 0,
    };
  const left = remaining(ctx.run.budget, ctx.run.usage, ctx.run.elapsedSeconds);
  const { label, ...rest } = req;
  const result = (await ports.llm.generate({
    ...rest,
    effort: ctx.run.config.effortByRole[req.role],
    ctx: {
      projectId: ctx.experiment.projectId,
      runId: ctx.run.id,
      signal: ctx.signal,
      remainingUsd: left.costUsd,
      remainingCalls: left.llmCalls,
      remainingOutputTokens: left.llmOutputTokens,
    },
  })) as LlmResult<z.output<S>>;
  acc.usage = {
    ...acc.usage,
    llmCalls: (acc.usage.llmCalls ?? 0) + result.attempts,
    llmInputTokens:
      (acc.usage.llmInputTokens ?? 0) +
      result.usage.inputTokens +
      result.usage.cachedInputTokens +
      result.usage.cacheWriteTokens,
    llmOutputTokens:
      (acc.usage.llmOutputTokens ?? 0) + result.usage.outputTokens,
    estimatedCostUsd: (acc.usage.estimatedCostUsd ?? 0) + result.costUsd,
  };
  const payload = {
    promptId: req.promptId,
    modelId: result.modelId,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    invocationIds: result.invocationIds,
    outputTokens: result.usage.outputTokens,
    costUsd: Number(result.costUsd.toFixed(6)),
  };
  if (result.attempts > 1)
    acc.events.push({
      type: "REPAIR_ATTEMPTED",
      role: req.role,
      summary: truncate(
        `${label}: retried after validation, truncation, or availability issue`,
      ),
      payload,
    });
  acc.events.push({
    type: "LLM_CALL_FINISHED",
    role: req.role,
    summary: truncate(
      `${label} → ${result.ok ? "valid output" : result.reason.toLowerCase()} (${result.modelId ?? "no model"}, ${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`,
    ),
    payload,
  });
  acc.events.push(
    result.ok
      ? {
          type: "VALIDATION_PASSED",
          role: req.role,
          summary: truncate(`${label}: schema and semantic validators passed`),
        }
      : {
          type: "VALIDATION_FAILED",
          role: req.role,
          summary: truncate(`${label}: ${result.reason}`),
          payload: {
            issues: (result.issues ?? [])
              .slice(0, 10)
              .map((i) => ({ code: i.code, path: i.path ?? null })),
          },
        },
  );
  return result;
}

/** Shared Qloo call: cancellation, quota usage, and tool events (no raw data in events). */
export async function qlooCall<T>(
  ctx: StepContext,
  acc: StepResult,
  method: string,
  call: () => Promise<QlooResult<T>>,
  label: string,
): Promise<QlooResult<T>> {
  if (ctx.signal?.aborted) throw new Cancelled();
  const result = await call();
  if (ctx.signal?.aborted) throw new Cancelled();
  const prov = "provenance" in result ? result.provenance : null;
  if (result.kind !== "UNSUPPORTED" && prov?.dataOrigin !== "CACHE")
    acc.usage = { ...acc.usage, qlooCalls: (acc.usage.qlooCalls ?? 0) + 1 };
  const count = result.kind === "OK" ? result.items.length : 0;
  acc.events.push({
    type: "TOOL_CALL_FINISHED",
    role: null,
    summary: truncate(
      `qloo ${method} → ${label}: ${result.kind.toLowerCase()}${result.kind === "OK" ? ` (${count})` : ""}${result.kind === "ERROR" ? ` ${result.code}` : ""}`,
    ),
    payload: {
      method,
      toolInvocationId: prov?.toolInvocationId ?? null,
      outcome: result.kind,
      resultCount: count,
      dataOrigin: prov?.dataOrigin ?? null,
    },
  });
  return result;
}

export function qlooFailure(result: QlooResult<unknown>): StepResult | null {
  if (result.kind !== "ERROR") return null;
  if (result.code === "QLOO_AUTH")
    return fatal("QLOO_UNAVAILABLE", "Qloo rejected the credential");
  if (result.code === "QLOO_NOT_CONFIGURED")
    return fatal(
      "QLOO_UNAVAILABLE",
      "Qloo access is not configured for this worker",
    );
  if (result.code === "QUOTA_GUARD_ACTIVE")
    return {
      ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
      terminalReason: "QUOTA_GUARD_ACTIVE",
    };
  return null;
}

export const qctx = (ctx: StepContext, purpose: string) => ({
  projectId: ctx.experiment.projectId,
  runId: ctx.run.id,
  stepSeq: ctx.run.stateVersion,
  purpose,
  signal: ctx.signal,
});

export const remainingNow = (ctx: StepContext, acc?: StepResult) =>
  remaining(
    ctx.run.budget,
    acc
      ? {
          ...ctx.run.usage,
          qlooCalls: ctx.run.usage.qlooCalls + (acc.usage.qlooCalls ?? 0),
          llmCalls: ctx.run.usage.llmCalls + (acc.usage.llmCalls ?? 0),
        }
      : ctx.run.usage,
    ctx.run.elapsedSeconds,
  );
