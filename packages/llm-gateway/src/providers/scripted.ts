import {
  ProviderError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderUsage,
  type StopReason,
} from "../types";

export const SCRIPTED_MODEL = "scripted-model";

/** One scripted turn. `output` is serialized to JSON unless `text` is given verbatim. */
export type ScriptedStep =
  | {
      output?: unknown;
      text?: string;
      stopReason?: StopReason;
      modelId?: string;
      usage?: Partial<ProviderUsage>;
      refusalCategory?: string | null;
    }
  | { error: ProviderError };

/** A step can depend on the request (for example to echo IDs from the input). */
export type ScriptedResponder = (request: ProviderRequest) => ScriptedStep;

/**
 * Deterministic provider for tests and the scripted demo mode. Steps are consumed per
 * prompt id, falling back to a shared queue.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = "scripted";
  readonly requests: ProviderRequest[] = [];
  private readonly byPrompt = new Map<
    string,
    (ScriptedStep | ScriptedResponder)[]
  >();
  private readonly queue: (ScriptedStep | ScriptedResponder)[] = [];

  /** Queue steps for a specific prompt id. */
  on(promptId: string, ...steps: (ScriptedStep | ScriptedResponder)[]): this {
    const list = this.byPrompt.get(promptId) ?? [];
    list.push(...steps);
    this.byPrompt.set(promptId, list);
    return this;
  }

  /** Queue steps consumed in order by any prompt without a dedicated script. */
  push(...steps: (ScriptedStep | ScriptedResponder)[]): this {
    this.queue.push(...steps);
    return this;
  }

  remaining(): number {
    let n = this.queue.length;
    for (const list of this.byPrompt.values()) n += list.length;
    return n;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted)
      throw new ProviderError("timeout", "LLM request aborted", false);
    this.requests.push(request);
    const promptId = request.promptId;
    const dedicated = this.byPrompt.get(promptId);
    const list = dedicated && dedicated.length > 0 ? dedicated : this.queue;
    const next = list.shift();
    if (!next)
      throw new ProviderError(
        "bad_request",
        `Scripted provider has no step for ${promptId}`,
        false,
      );
    const step = typeof next === "function" ? next(request) : next;
    if ("error" in step) throw step.error;
    const text = step.text ?? JSON.stringify(step.output ?? null);
    return {
      text,
      stopReason: step.stopReason ?? "end_turn",
      modelId: step.modelId ?? request.model,
      usage: {
        inputTokens:
          step.usage?.inputTokens ??
          Math.ceil(
            (request.system.length +
              request.messages.reduce((n, m) => n + m.content.length, 0)) /
              3.5,
          ),
        cachedInputTokens: step.usage?.cachedInputTokens ?? 0,
        cacheWriteTokens: step.usage?.cacheWriteTokens ?? 0,
        outputTokens: step.usage?.outputTokens ?? Math.ceil(text.length / 3.5),
      },
      refusalCategory: step.refusalCategory ?? null,
    };
  }
}
