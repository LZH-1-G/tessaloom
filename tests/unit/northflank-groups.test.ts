import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWebEnv, parseWorkerEnv } from "../../packages/config/env";

// The prepared Northflank config groups (runbook §2.2) must parse with the real schemas and pin
// every limit explicitly: production leaves these unset, so the code defaults (Opus, $15/day)
// would apply the moment a key is added without them.
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../deploy/northflank-groups/llm-limits.${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    name: string;
    description: string;
    type: string;
    restrictions: { restricted: boolean; nfObjects: { id: string }[] };
    secrets: { variables: Record<string, string> };
  };

const base = {
  NODE_ENV: "production",
  APP_ENV: "production",
  QLOO_MODE: "live",
  RUN_ACCESS: "invite",
  DATABASE_URL: "postgres://u:p@db.internal:5432/x?sslmode=require",
  SESSION_SECRET: "s".repeat(40),
  SHARE_TOKEN_PEPPER: "p".repeat(40),
  QLOO_BASE_URL: "https://hackathon.api.qloo.com",
  QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com",
};

const expected = {
  closed: { usd: [0, 0, 0], qloo: 0, working: 1, daily: 1 },
  acceptance: { usd: [0.5, 0.5, 0.5], qloo: 60, working: 1, daily: 2 },
  judging: { usd: [4, 1, 1], qloo: 400, working: 2, daily: 6 },
} as const;

describe("prepared Northflank limit groups", () => {
  for (const [name, want] of Object.entries(expected)) {
    it(`${name}: pins Sonnet and its caps, holds no secrets, targets only tessaloom`, () => {
      const group = load(name);
      const vars = group.secrets.variables;
      expect(group.name).toBe("tessaloom-llm-limits");
      expect(group.type).toBe("config");
      expect(group.description).not.toContain("=");
      expect(group.restrictions).toMatchObject({
        restricted: true,
        nfObjects: [{ id: "tessaloom", type: "service" }],
      });
      expect(
        Object.keys(vars).filter((k) =>
          /KEY|SECRET|TOKEN|PEPPER|PASSWORD|DATABASE_URL|RUN_ACCESS/.test(k),
        ),
      ).toEqual([]);

      const worker = parseWorkerEnv({ ...base, ...vars });
      const web = parseWebEnv({ ...base, ...vars });
      expect(worker).toMatchObject({
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "claude-sonnet-5-5",
        LLM_FALLBACK_MODEL: "claude-sonnet-5-5",
        CLAUDE_SUBSCRIPTION_LOCAL_APPROVED: "off",
        DEEPSEEK_LIVE_APPROVED: "off",
        GLOBAL_DAILY_LLM_USD: want.usd[0],
        WORKSPACE_DAILY_LLM_USD: want.usd[1],
        EXPERIMENT_LLM_USD: want.usd[2],
        GLOBAL_DAILY_QLOO_CALLS: want.qloo,
      });
      expect(web).toMatchObject({
        MAX_WORKING_RUNS: want.working,
        MAX_ACTIVE_RUNS_PER_WORKSPACE: 1,
        WORKSPACE_DAILY_RUNS: want.daily,
      });
    });
  }
});

describe("prepared Gemini limit group (not applied)", () => {
  it("pins paid-capable Flash-Lite with acceptance caps, but stays inert without owner approvals", async () => {
    const { createLlmGateway } = await import("../../apps/worker/src/llm");
    const group = load("gemini-acceptance");
    const vars = group.secrets.variables;
    expect(group.name).toBe("tessaloom-llm-limits");
    expect(group.description).not.toContain("=");
    expect(group.restrictions).toMatchObject({
      restricted: true,
      nfObjects: [{ id: "tessaloom", type: "service" }],
    });
    expect(
      Object.keys(vars).filter((k) =>
        /KEY|SECRET|TOKEN|PEPPER|PASSWORD|DATABASE_URL|RUN_ACCESS/.test(k),
      ),
    ).toEqual([]);
    // Same caps as the Anthropic acceptance set; only the provider changes.
    const anthropic = load("acceptance").secrets.variables;
    for (const key of Object.keys(anthropic).filter((k) =>
      /_USD$|_QLOO_CALLS$|_RUNS/.test(k),
    ))
      expect(vars[key]).toBe(anthropic[key]);
    const worker = parseWorkerEnv({ ...base, ...vars });
    expect(worker).toMatchObject({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-3.5-flash-lite",
      GEMINI_FREE_TIER_CONFIRMED: "off",
      GEMINI_PAID_TIER_APPROVED: "off",
      GEMINI_LIVE_DATA_APPROVED: "off",
      GEMINI_MAX_REQUESTS: 60,
    });
    parseWebEnv({ ...base, ...vars });
    // Even with a key, no approvals means no LLM: runs report it unconfigured.
    expect(
      createLlmGateway(
        { ...worker, GEMINI_API_KEY: "sentinel" },
        { record: async () => "id" },
      ),
    ).toBeNull();
  });
});
