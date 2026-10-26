import { describe, expect, it } from "vitest";
import {
  describeRunStop,
  POOL_TOO_SMALL_TIPS,
} from "../../apps/web/src/lib/run-outcome";

describe("describeRunStop", () => {
  it("explains an insufficient live collision pool and points back to the brief", () => {
    const copy = describeRunStop("POOL_TOO_SMALL");
    expect(copy.action).toBe("new-brief");
    expect(copy.title).toMatch(/bridges/i);
    expect(copy.detail).toMatch(/different worlds/);
    expect(POOL_TOO_SMALL_TIPS.some((t) => /third interest/.test(t))).toBe(
      true,
    );
    expect(describeRunStop("NO_DISCOVERY_DATA").action).toBe("new-brief");
  });

  it("offers retry only for transient step failures", () => {
    expect(describeRunStop("LLM_UNAVAILABLE").action).toBe("retry");
    expect(describeRunStop("STEP_RETRIES_EXHAUSTED").action).toBe("retry");
    for (const code of [
      "LLM_NOT_CONFIGURED",
      "QLOO_NOT_CONFIGURED",
      "QLOO_UNAVAILABLE",
      "LLM_INVALID_OUTPUT",
      "BUDGET:LLM",
      "SOMETHING_NEW",
      null,
    ])
      expect(describeRunStop(code).action).not.toBe("retry");
  });

  it("says plainly when a deployment cannot generate, without blaming the user", () => {
    expect(describeRunStop("LLM_NOT_CONFIGURED").detail).toMatch(
      /Saved results remain readable/,
    );
  });

  it("covers budget limits and keeps unknown codes visible without inventing a cause", () => {
    expect(describeRunStop("BUDGET:LLM").title).toMatch(/budget/i);
    expect(describeRunStop("SOMETHING_NEW").detail).toContain("something new");
    expect(describeRunStop(null).detail).toBe("Your data so far is saved.");
  });
});
