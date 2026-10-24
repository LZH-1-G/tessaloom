import type { z } from "zod";

export type AgentRole = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** One provider call. The gateway owns conversation shape; providers stay stateless. */
export interface ProviderRequest {
  promptId: string; // routing/trace metadata only; never sent to the provider
  model: string;
  system: string; // stable, cacheable prefix (role instructions)
  messages: ChatMessage[];
  jsonSchema: Record<string, unknown>; // structured-output schema (JSON Schema)
  effort: Effort;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "stop_sequence"
  | "pause_turn"
  | "tool_use"
  | "other";

export interface ProviderUsage {
  /** Subset of outputTokens, never billed twice; no reasoning text is retained. */
  reasoningTokens?: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text: string; // concatenated text blocks (the structured JSON output)
  stopReason: StopReason;
  modelId: string; // model that actually served the request
  usage: ProviderUsage;
  refusalCategory?: string | null;
}

/** Normalized provider failure. Message text never contains prompts or credentials. */
export class ProviderError extends Error {
  constructor(
    readonly kind:
      | "unavailable"
      | "rate_limited"
      | "auth"
      | "bad_request"
      | "timeout"
      | "unknown",
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly requestSent: boolean = true,
  ) {
    super(message);
  }
}

export interface LlmProvider {
  readonly name: string;
  /** Explicit account attestation; reservations still use conservative published paid rates. */
  readonly billing?: "confirmed-free-tier";
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ValidationIssue {
  code: string;
  path?: string;
  message: string;
}

/** Semantic validators are injected by the caller (worker/agent); the gateway depends on core only. */
export type SemanticValidator<T> = (value: T) => ValidationIssue[];

export interface LlmCallContext {
  inputOrigin?: "synthetic" | "unknown";
  projectId: string;
  runId?: string | null;
  signal?: AbortSignal;
  /** Remaining run budget; undefined = not budgeted (tests, tooling). */
  remainingUsd?: number;
  remainingCalls?: number;
  remainingOutputTokens?: number;
}

export interface GenerateRequest<S extends z.ZodType> {
  role: AgentRole;
  promptId: string;
  input: unknown; // untrusted data, wrapped in a delimited JSON block
  inputExcerpt?: Record<string, unknown>; // safe structured summary for persistence
  schema: S;
  effort: Effort;
  maxOutputTokens: number;
  validate?: SemanticValidator<z.output<S>>;
  ctx: LlmCallContext;
}

export type FailureReason =
  | "REFUSED"
  | "TRUNCATED"
  | "INVALID_OUTPUT"
  | "UNAVAILABLE"
  | "BUDGET"
  | "CANCELLED"
  | "CONFIGURATION";

export interface GenerateMeta {
  usageComplete?: boolean;
  invocationIds: string[];
  modelId: string | null;
  fallbackUsed: boolean;
  fallbackReason: "economy" | "budget" | "unavailable" | null;
  usage: ProviderUsage;
  costUsd: number;
  attempts: number;
}

export type GenerateResult<T> =
  | ({ ok: true; value: T } & GenerateMeta)
  | ({
      ok: false;
      reason: FailureReason;
      issues?: ValidationIssue[];
      /** INVALID_OUTPUT only: the schema-valid output whose semantic checks failed. */
      salvage?: T;
    } & GenerateMeta);

/** Persists one provider call (repairs and retries are separate rows linked by repairOfId). */
export interface LlmInvocationRecorder {
  record(input: {
    ctx: LlmCallContext;
    role: AgentRole;
    promptId: string;
    promptVersion: string;
    provider: string;
    modelId: string;
    fallbackUsed: boolean;
    effort: Effort;
    inputHash: string;
    inputExcerpt: Record<string, unknown>;
    output: unknown;
    validationStatus:
      "VALID" | "REPAIRED" | "INVALID" | "REFUSED" | "TRUNCATED";
    validationErrors: ValidationIssue[] | null;
    repairOfId: string | null;
    stopReason: string | null;
    usage: ProviderUsage;
    costUsd: number;
    latencyMs: number;
  }): Promise<string>;
}

/**
 * M10-A spend ledger hook. The gateway reserves an upper-bound cost before *every* provider
 * attempt (first try, repair, truncation retry, fallback) and settles it with the actual cost
 * afterwards; `null` = outcome unknown, so the full reservation stays charged.
 */
export interface SpendGuard {
  reserve(input: {
    ctx: LlmCallContext;
    model: string;
    upperBoundUsd: number;
    maxOutputTokens?: number;
  }): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; code: string; message: string }
  >;
  settle(reservationId: string, actualUsd: number | null): Promise<void>;
}
