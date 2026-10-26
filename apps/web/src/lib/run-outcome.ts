/** What the user can do next after a run stops. */
export type RunStopAction = "retry" | "new-brief" | "none";

export interface RunStopCopy {
  title: string;
  detail: string;
  action: RunStopAction;
}

/**
 * Plain-language copy for a stopped run, keyed by the worker's terminal reason. Unknown codes
 * fall back to a generic message: the code is shown, never invented into a cause.
 */
export function describeRunStop(reason: string | null): RunStopCopy {
  const code = reason ?? "";
  if (code.startsWith("BUDGET"))
    return {
      title: "Stopped at a budget limit",
      detail:
        "This run used its allowance. Results so far are kept and untested claims stay marked.",
      action: "none",
    };
  switch (code) {
    case "POOL_TOO_SMALL":
      return {
        title: "Not enough cultural bridges to build hypotheses",
        detail:
          "Qloo returned results, but too few pairs connect your interests across different worlds. A bridge needs the same item to appear in two interests' threads, or a shared Qloo theme between items from different worlds.",
        action: "new-brief",
      };
    case "NO_DISCOVERY_DATA":
      return {
        title: "No discovery results came back",
        detail:
          "None of the discovery queries returned data for these interests. Try better-known titles or names, or choose “Not sure” for the world.",
        action: "new-brief",
      };
    case "LLM_UNAVAILABLE":
    case "STEP_RETRIES_EXHAUSTED":
      return {
        title: "A step could not be completed",
        detail:
          "The AI or data service was temporarily unavailable. Your data so far is saved; you can retry the step.",
        action: "retry",
      };
    case "LLM_NOT_CONFIGURED":
    case "QLOO_NOT_CONFIGURED":
      return {
        title: "Generation is not available here",
        detail:
          "This deployment has no AI or data provider configured for new runs. Saved results remain readable.",
        action: "none",
      };
    case "QLOO_UNAVAILABLE":
    case "QLOO_AUTH":
      return {
        title: "The Qloo service could not be reached",
        detail:
          "No cultural data was retrieved for this step. Your data so far is saved.",
        action: "none",
      };
    case "LLM_REFUSED":
      return {
        title: "The AI declined this request",
        detail:
          "The model's safeguards stopped this step. Rephrasing the brief usually helps.",
        action: "new-brief",
      };
    case "LLM_INVALID_OUTPUT":
    case "LLM_OUTPUT_TRUNCATED":
      return {
        title: "The AI response did not pass validation",
        detail:
          "Tessaloom rejects output that breaks its schema or evidence rules rather than showing it. Your data so far is saved.",
        action: "none",
      };
    case "EXPIRED":
      return {
        title: "The run expired while waiting",
        detail:
          "A confirmation step waited more than 24 hours. Start again from the brief.",
        action: "new-brief",
      };
    default:
      return {
        title: "The run stopped",
        detail: code
          ? `Reason: ${code.replace(/_/g, " ").toLowerCase()}. Your data so far is saved.`
          : "Your data so far is saved.",
        action: "none",
      };
  }
}

/** Concrete next steps when live Qloo data yields too few bridges (no extra Qloo calls). */
export const POOL_TOO_SMALL_TIPS = [
  "Add a third interest from another world (for example a film, place or author) — each interest adds its own discovery threads.",
  "Prefer widely known titles or names over niche ones; Qloo has more audience data for them.",
  "Pick interests that plausibly share an audience, or set the world to “Not sure” so tags are searched too.",
] as const;
