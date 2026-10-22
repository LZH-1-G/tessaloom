import { canonicalize, sha256Hex } from "@tessaloom/core";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  hasPrice,
  upperBoundCostUsd,
  worstCaseCostUsd,
} from "./cost";
import {
  PromptRegistry,
  wrapUntrusted,
  type RegisteredPrompt,
} from "./prompts";
import {
  ProviderError,
  type ChatMessage,
  type FailureReason,
  type GenerateMeta,
  type GenerateRequest,
  type GenerateResult,
  type LlmInvocationRecorder,
  type LlmProvider,
  type ProviderResponse,
  type SpendGuard,
  type ValidationIssue,
} from "./types";

export type LlmMode = "standard" | "economy";

export interface LlmGatewayOptions {
  provider: LlmProvider;
  primaryModel: string;
  fallbackModel?: string | null;
  mode?: LlmMode;
  prompts?: PromptRegistry;
  recorder?: LlmInvocationRecorder;
  /** Repair attempts after a schema/semantic failure (AGENT_WORKFLOW §10: 1). */
  maxRepairs?: number;
  /** Hard ceiling for the truncation retry's 1.5× output cap. */
  maxOutputTokensCeiling?: number;
  /** Allow models without a price entry (scripted provider only). */
  allowUnpricedModels?: boolean;
  /** M10-A: reserve and settle every provider attempt in the spend ledger (fail-closed). */
  spendGuard?: SpendGuard;
  now?: () => number;
}

interface Attempt {
  model: string;
  fallbackUsed: boolean;
  fallbackReason: GenerateMeta["fallbackReason"];
}

/**
 * The single LLM entry point. Owns prompt assembly, model choice, budget pre-checks,
 * the repair/truncation/fallback policies, output validation, and invocation records.
 * Semantic validators are injected by the caller (ADR-022).
 */
export class LlmGateway {
  readonly prompts: PromptRegistry;
  private readonly provider: LlmProvider;
  private readonly primaryModel: string;
  private readonly fallbackModel: string | null;
  private readonly mode: LlmMode;
  private readonly recorder?: LlmInvocationRecorder;
  private readonly maxRepairs: number;
  private readonly ceiling: number;
  private readonly allowUnpriced: boolean;
  private readonly spendGuard?: SpendGuard;
  private readonly now: () => number;

  constructor(options: LlmGatewayOptions) {
    this.provider = options.provider;
    this.primaryModel = options.primaryModel;
    this.fallbackModel = options.fallbackModel ?? null;
    this.mode = options.mode ?? "standard";
    this.prompts = options.prompts ?? new PromptRegistry();
    this.recorder = options.recorder;
    this.maxRepairs = options.maxRepairs ?? 1;
    this.ceiling = options.maxOutputTokensCeiling ?? 32_000;
    this.allowUnpriced =
      options.provider.name === "scripted" &&
      (options.allowUnpricedModels ?? false);
    this.spendGuard = options.spendGuard;
    this.now = options.now ?? (() => performance.now());
  }

  get providerName(): string {
    return this.provider.name;
  }

  async generate<S extends z.ZodType>(
    req: GenerateRequest<S>,
  ): Promise<GenerateResult<z.output<S>>> {
    const prompt = this.prompts.get(req.promptId);
    if (prompt.role !== req.role)
      throw new Error(
        `Prompt ${prompt.id} belongs to ${prompt.role}, not ${req.role}`,
      );

    const userTurn = `${prompt.task}\n\n${wrapUntrusted(req.input)}`;
    const promptChars = prompt.system.length + userTurn.length;
    const jsonSchema = toStructuredSchema(req.schema);
    const inputHash = sha256Hex(
      canonicalize({
        promptId: prompt.id,
        contentHash: prompt.contentHash,
        input: req.input ?? null,
      }),
    );

    const meta: GenerateMeta = {
      invocationIds: [],
      modelId: null,
      fallbackUsed: false,
      fallbackReason: null,
      usage: emptyUsage(),
      costUsd: 0,
      attempts: 0,
    };
    const fail = (
      reason: FailureReason,
      issues?: ValidationIssue[],
      salvage?: z.output<S>,
    ): GenerateResult<z.output<S>> => ({
      ok: false,
      reason,
      ...(issues ? { issues } : {}),
      ...(salvage !== undefined ? { salvage } : {}),
      ...meta,
    });

    let attempt = this.chooseModel(
      promptChars,
      req.maxOutputTokens,
      req.ctx.remainingUsd,
    );
    if (!attempt)
      return fail("BUDGET", [
        {
          code: "BUDGET_USD",
          message: "Remaining LLM budget is below one call",
        },
      ]);
    if (!this.allowUnpriced && !hasPrice(attempt.model))
      return fail("CONFIGURATION", [
        {
          code: "UNPRICED_MODEL",
          message: `No price entry for ${attempt.model}`,
        },
      ]);

    let messages: ChatMessage[] = [{ role: "user", content: userTurn }];
    let maxTokens = req.maxOutputTokens;
    let repairs = 0;
    let truncationRetried = false;
    let repairOfId: string | null = null;
    let switchedForUnavailability = false;

    for (;;) {
      if (req.ctx.signal?.aborted) return fail("CANCELLED");
      if (this.provider.name !== "scripted" && !this.spendGuard)
        return fail("CONFIGURATION", [
          {
            code: "SPEND_GUARD_REQUIRED",
            message: "Paid calls require spending reservations",
          },
        ]);
      if (!this.allowUnpriced && !hasPrice(attempt.model))
        return fail("CONFIGURATION", [
          {
            code: "UNPRICED_MODEL",
            message: "The serving model must have a verified price",
          },
        ]);
      if (
        !Number.isSafeInteger(maxTokens) ||
        maxTokens <= 0 ||
        maxTokens > this.ceiling
      )
        return fail("CONFIGURATION", [
          { code: "OUTPUT_LIMIT", message: "Invalid output token limit" },
        ]);
      const budgetIssue = this.checkBudget(
        req,
        meta,
        attempt.model,
        promptChars,
        maxTokens,
        messages,
      );
      if (budgetIssue) return fail("BUDGET", [budgetIssue]);

      // Reserve before the provider sees anything; a refusal or a ledger error stops the call.
      let reservationId: string | null = null;
      if (this.spendGuard) {
        const bytes = new TextEncoder().encode(
          prompt.system +
            messages.map((m) => m.content).join("") +
            JSON.stringify(jsonSchema),
        ).length;
        const reserved = await this.spendGuard.reserve({
          ctx: req.ctx,
          model: attempt.model,
          upperBoundUsd: upperBoundCostUsd(attempt.model, bytes, maxTokens),
          maxOutputTokens: maxTokens,
        });
        if (!reserved.ok)
          return fail("BUDGET", [
            { code: reserved.code, message: reserved.message },
          ]);
        reservationId = reserved.reservationId;
      }
      const settle = async (actualUsd: number | null) => {
        if (!reservationId || !this.spendGuard) return;
        // A failed settlement leaves the upper bound charged, which errs on the safe side.
        await this.spendGuard.settle(reservationId, actualUsd).catch(() => {});
        reservationId = null;
      };

      meta.attempts += 1;
      const started = this.now();
      let response: ProviderResponse;
      try {
        response = await this.provider.generate({
          promptId: prompt.id,
          model: attempt.model,
          system: prompt.system,
          messages,
          jsonSchema,
          effort: req.effort,
          maxOutputTokens: maxTokens,
          signal: req.ctx.signal,
        });
      } catch (error) {
        await settle(null); // the provider may have billed: keep the full reservation
        const pe =
          error instanceof ProviderError
            ? error
            : new ProviderError("unknown", "LLM call failed", false);
        if (req.ctx.signal?.aborted) return fail("CANCELLED");
        if (pe.kind === "auth" || pe.kind === "bad_request")
          return fail("CONFIGURATION", [
            { code: `PROVIDER_${pe.kind.toUpperCase()}`, message: pe.message },
          ]);
        // Whole-step retry on the fallback model; never switched mid-conversation.
        if (
          pe.retryable &&
          !switchedForUnavailability &&
          this.fallbackModel &&
          attempt.model !== this.fallbackModel
        ) {
          switchedForUnavailability = true;
          attempt = {
            model: this.fallbackModel,
            fallbackUsed: true,
            fallbackReason: "unavailable",
          };
          messages = [{ role: "user", content: userTurn }];
          maxTokens = req.maxOutputTokens;
          repairs = 0;
          truncationRetried = false;
          repairOfId = null;
          continue;
        }
        return fail("UNAVAILABLE", [
          { code: `PROVIDER_${pe.kind.toUpperCase()}`, message: pe.message },
        ]);
      }
      const latencyMs = Math.round(this.now() - started);

      const servedBy = response.modelId || attempt.model;
      if (
        this.provider.name !== "scripted" &&
        (!hasPrice(servedBy) || servedBy !== attempt.model)
      ) {
        await settle(null);
        return fail("CONFIGURATION", [
          {
            code: "UNEXPECTED_MODEL",
            message:
              "Provider returned an unexpected model; reservation retained",
          },
        ]);
      }
      if (
        Object.values(response.usage).some(
          (n) => !Number.isSafeInteger(n) || n < 0,
        )
      ) {
        await settle(null);
        return fail("CONFIGURATION", [
          {
            code: "INVALID_USAGE",
            message: "Provider usage is invalid; reservation retained",
          },
        ]);
      }
      const costUsd = estimateCostUsd(servedBy, response.usage);
      await settle(costUsd);
      meta.usage = addUsage(meta.usage, response.usage);
      meta.costUsd += costUsd;
      meta.modelId = servedBy;
      // Server-side fallback shows up as a different serving model.
      const fallbackUsed = attempt.fallbackUsed || servedBy !== attempt.model;
      meta.fallbackUsed = meta.fallbackUsed || fallbackUsed;
      if (fallbackUsed && !meta.fallbackReason)
        meta.fallbackReason = attempt.fallbackReason ?? "unavailable";

      const record = async (
        status: "VALID" | "REPAIRED" | "INVALID" | "REFUSED" | "TRUNCATED",
        output: unknown,
        errors: ValidationIssue[] | null,
      ): Promise<string | null> => {
        if (!this.recorder) return null;
        const id = await this.recorder.record({
          ctx: req.ctx,
          role: req.role,
          promptId: prompt.id,
          promptVersion: versionLabel(prompt),
          provider: this.provider.name,
          modelId: servedBy,
          fallbackUsed,
          effort: req.effort,
          inputHash,
          inputExcerpt: req.inputExcerpt ?? { promptId: prompt.id },
          output,
          validationStatus: status,
          validationErrors: errors,
          repairOfId,
          stopReason: response.stopReason,
          usage: response.usage,
          costUsd,
          latencyMs,
        });
        meta.invocationIds.push(id);
        return id;
      };

      if (response.stopReason === "refusal") {
        await record("REFUSED", null, [
          {
            code: "REFUSAL",
            message: `Model declined (${response.refusalCategory ?? "uncategorized"})`,
          },
        ]);
        return fail("REFUSED");
      }

      if (response.stopReason === "max_tokens") {
        await record("TRUNCATED", truncatedOutput(response.text), [
          { code: "MAX_TOKENS", message: `Output reached ${maxTokens} tokens` },
        ]);
        const nextCap = Math.ceil(maxTokens * 1.5);
        if (!truncationRetried && nextCap <= this.ceiling) {
          truncationRetried = true;
          maxTokens = nextCap;
          continue; // same conversation, larger cap; budget is re-checked at the loop top
        }
        return fail("TRUNCATED");
      }

      const issues =
        response.stopReason === "end_turn" ||
        response.stopReason === "stop_sequence"
          ? []
          : [
              {
                code: "UNEXPECTED_STOP",
                message: `Unexpected stop reason ${response.stopReason}`,
              },
            ];
      let value: unknown;
      let schemaValid: z.output<S> | undefined;
      if (issues.length === 0) {
        const parsed = parseAndValidate(
          response.text,
          req.schema,
          req.validate,
        );
        if (parsed.ok) value = parsed.value;
        else {
          issues.push(...parsed.issues);
          schemaValid = parsed.schemaValid;
        }
      }

      if (issues.length === 0) {
        await record(repairs > 0 ? "REPAIRED" : "VALID", value, null);
        return { ok: true, value: value as z.output<S>, ...meta };
      }

      const invalidId = await record(
        "INVALID",
        safeJson(response.text),
        issues,
      );
      // After the repair budget, a schema-valid output that only fails semantic checks is
      // returned as `salvage`, so the caller can drop the invalid parts (TEST_PLAN §8).
      if (repairs >= this.maxRepairs)
        return fail("INVALID_OUTPUT", issues, schemaValid);
      repairs += 1;
      repairOfId = invalidId;
      // Append-only repair: the model sees its own output and the validation errors.
      messages = [
        ...messages,
        { role: "assistant", content: response.text || "{}" },
        { role: "user", content: repairMessage(issues) },
      ];
    }
  }

  /** Primary unless economy mode or the remaining budget only fits the fallback. */
  private chooseModel(
    promptChars: number,
    maxTokens: number,
    remainingUsd?: number,
  ): Attempt | null {
    const fallback = this.fallbackModel;
    if (this.mode === "economy" && fallback)
      return { model: fallback, fallbackUsed: true, fallbackReason: "economy" };
    if (
      remainingUsd === undefined ||
      worstCaseCostUsd(this.primaryModel, promptChars, maxTokens) <=
        remainingUsd
    )
      return {
        model: this.primaryModel,
        fallbackUsed: false,
        fallbackReason: null,
      };
    if (
      fallback &&
      worstCaseCostUsd(fallback, promptChars, maxTokens) <= remainingUsd
    )
      return { model: fallback, fallbackUsed: true, fallbackReason: "budget" };
    return null;
  }

  private checkBudget<S extends z.ZodType>(
    req: GenerateRequest<S>,
    meta: GenerateMeta,
    model: string,
    promptChars: number,
    maxTokens: number,
    messages: ChatMessage[],
  ): ValidationIssue | null {
    const { remainingUsd, remainingCalls, remainingOutputTokens } = req.ctx;
    if (remainingCalls !== undefined && meta.attempts >= remainingCalls)
      return { code: "BUDGET_CALLS", message: "LLM call budget exhausted" };
    if (
      remainingOutputTokens !== undefined &&
      meta.usage.outputTokens + maxTokens > remainingOutputTokens
    )
      return {
        code: "BUDGET_OUTPUT_TOKENS",
        message: "LLM output-token budget exhausted",
      };
    if (remainingUsd !== undefined) {
      const chars =
        promptChars +
        messages.slice(1).reduce((n, m) => n + m.content.length, 0);
      if (
        meta.costUsd + worstCaseCostUsd(model, chars, maxTokens) >
        remainingUsd
      )
        return { code: "BUDGET_USD", message: "LLM cost budget exhausted" };
    }
    return null;
  }
}

/**
 * JSON Schema for the provider's structured-output parameter, via the SDK's documented
 * `zodOutputFormat` helper (strict transform: unsupported constraints move into
 * descriptions and are enforced by our own Zod parse afterwards).
 */
export function toStructuredSchema(schema: z.ZodType): Record<string, unknown> {
  return zodOutputFormat(schema).schema as Record<string, unknown>;
}

export function parseAndValidate<S extends z.ZodType>(
  text: string,
  schema: S,
  validate?: (value: z.output<S>) => ValidationIssue[],
):
  | { ok: true; value: z.output<S> }
  | { ok: false; issues: ValidationIssue[]; schemaValid?: z.output<S> } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      issues: [{ code: "INVALID_JSON", message: "Output is not valid JSON" }],
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        code: "SCHEMA",
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    };
  }
  const semantic = validate?.(parsed.data) ?? [];
  return semantic.length > 0
    ? { ok: false, issues: semantic.slice(0, 20), schemaValid: parsed.data }
    : { ok: true, value: parsed.data };
}

function repairMessage(issues: ValidationIssue[]): string {
  const lines = issues.map(
    (i) => `- [${i.code}]${i.path ? ` at ${i.path}` : ""}: ${i.message}`,
  );
  return `Your previous output failed validation:\n${lines.join("\n")}\nReturn a corrected JSON object that fixes every issue. Keep all other content unchanged. Follow the safe-use rules.`;
}

function versionLabel(prompt: RegisteredPrompt): string {
  return `${prompt.version}+${prompt.contentHash.slice(0, 12)}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: text.slice(0, 4000) };
  }
}

function truncatedOutput(text: string): unknown {
  return { truncated: text.slice(0, 4000) };
}
