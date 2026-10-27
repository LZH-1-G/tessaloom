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
  it("pins paid-capable Gemini 3.8 Flash with acceptance caps, but stays inert without owner approvals", async () => {
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
      LLM_MODEL: "gemini-3.8-flash",
      LLM_FALLBACK_MODEL: "gemini-3.8-flash",
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

describe("Gemini 3.8 Flash reservations fit the prepared caps", () => {
  it("admits the largest single attempt the code allows, even at 2027 rates", async () => {
    const { geminiPrices, upperBoundCostUsd } =
      await import("../../packages/llm-gateway/src");
    const jan2027 = geminiPrices(Date.parse("2027-01-01T00:00:00Z"));
    // 128 KiB provider input cap, 32k gateway output ceiling (thinking included).
    const worst = upperBoundCostUsd(
      "gemini-3.8-flash",
      128 * 1024,
      32_000,
      jan2027,
    );
    expect(worst).toBeCloseTo(0.442752, 6);
    for (const name of ["gemini-acceptance", "judging"]) {
      const vars = load(name).secrets.variables;
      for (const cap of [
        "GLOBAL_DAILY_LLM_USD",
        "WORKSPACE_DAILY_LLM_USD",
        "EXPERIMENT_LLM_USD",
      ])
        expect(Number(vars[cap]), `${name} ${cap}`).toBeGreaterThan(worst);
    }
  });
});

describe("Gemini rollback paths (config groups replace each other wholesale)", () => {
  const approved = {
    GEMINI_PAID_TIER_APPROVED: "on",
    GEMINI_PRICING_VERIFIED_AT: new Date().toISOString(),
  };
  const gateway = async (vars: Record<string, string>, keys: object) => {
    const { createLlmGateway } = await import("../../apps/worker/src/llm");
    return createLlmGateway(
      { ...parseWorkerEnv({ ...base, ...vars }), ...keys },
      { record: async () => "id" },
    );
  };

  it("runs Gemini only with the key and owner approvals", async () => {
    const vars = {
      ...load("gemini-acceptance").secrets.variables,
      ...approved,
    };
    expect(
      (await gateway(vars, { GEMINI_API_KEY: "sentinel" }))?.providerName,
    ).toBe("gemini");
    // Gemini-only stop: zero requests leaves the LLM unconfigured.
    expect(
      await gateway(
        { ...vars, GEMINI_MAX_REQUESTS: "0" },
        { GEMINI_API_KEY: "sentinel" },
      ),
    ).toBeNull();
  });
  it.each(["closed", "acceptance", "judging"])(
    "re-applying %s selects Anthropic, which is NOT a working fallback without an Anthropic key",
    async (name) => {
      const vars = load(name).secrets.variables;
      // The Gemini key may still be on the worker; it is ignored, never used as a fallback.
      expect(await gateway(vars, { GEMINI_API_KEY: "sentinel" })).toBeNull();
      expect(
        (
          await gateway(vars, {
            GEMINI_API_KEY: "sentinel",
            ANTHROPIC_API_KEY: "sentinel",
          })
        )?.providerName,
      ).toBe("anthropic");
    },
  );
});

describe("prepared Gemini 4 Argon acceptance group (not applied)", () => {
  it("pins Argon, stays inert without approvals, and differs from the 3.8 set only in model, request cap, timeout and USD caps", async () => {
    const { createLlmGateway } = await import("../../apps/worker/src/llm");
    const group = load("gemini-argon-acceptance");
    const vars = group.secrets.variables;
    expect(group.name).toBe("tessaloom-llm-limits");
    expect(group.restrictions).toMatchObject({
      restricted: true,
      nfObjects: [{ id: "tessaloom", type: "service" }],
    });
    const flash = load("gemini-acceptance").secrets.variables;
    const changed = Object.keys({ ...vars, ...flash })
      .filter((k) => vars[k] !== flash[k])
      .sort();
    expect(changed).toEqual(
      [
        "EXPERIMENT_LLM_USD",
        "GEMINI_MAX_REQUESTS",
        "GEMINI_TIMEOUT_MS",
        "GLOBAL_DAILY_LLM_USD",
        "LLM_FALLBACK_MODEL",
        "LLM_MODEL",
        "WORKSPACE_DAILY_LLM_USD",
      ].sort(),
    );
    const worker = parseWorkerEnv({ ...base, ...vars });
    expect(worker).toMatchObject({
      LLM_MODEL: "gemini-4-argon",
      GEMINI_PAID_TIER_APPROVED: "off",
      GEMINI_LIVE_DATA_APPROVED: "off",
      GEMINI_TIMEOUT_MS: 120_000,
      EXPERIMENT_LLM_USD: 1,
    });
    expect(
      createLlmGateway(
        { ...worker, GEMINI_API_KEY: "sentinel" },
        { record: async () => "id" },
      ),
    ).toBeNull();
  });

  it("lets one full-cap Argon workflow finish under the $1.00 experiment cap at November 2026 rates", async () => {
    const { geminiPrices, upperBoundCostUsd, estimateCostUsd } =
      await import("../../packages/llm-gateway/src");
    const { MAX_OUTPUT } =
      await import("../../packages/agent/src/steps/common");
    const nov = geminiPrices(Date.parse("2026-11-02T00:00:00Z"));
    const cap = Number(
      load("gemini-argon-acceptance").secrets.variables.EXPERIMENT_LLM_USD,
    );
    // Exploration with one revision round, then a blueprint. Every call spends its full
    // output cap (thinking included) on a conservative 32 KiB prompt; the ledger admits an
    // attempt only while spent + its upper-bound reservation stays within the cap.
    const prompt = 32 * 1024;
    let spent = 0;
    for (const role of ["R1", "R3", "R4", "R3", "R4", "R6"] as const) {
      const out = MAX_OUTPUT[role];
      const reserve = upperBoundCostUsd("gemini-4-argon", prompt, out, nov);
      expect(spent + reserve, role).toBeLessThanOrEqual(cap);
      spent += estimateCostUsd(
        "gemini-4-argon",
        {
          inputTokens: prompt,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: out,
        },
        nov,
      );
    }
  });
});

describe("prepared public judge demo group (not applied)", () => {
  const demo = {
    ...base,
    APP_ENV: "staging",
    QLOO_MODE: "synthetic",
    RUN_ACCESS: "open",
  };
  it("runs synthetic Qloo with scripted AI at $0 and holds no secrets", async () => {
    const { createLlmGateway } = await import("../../apps/worker/src/llm");
    const group = load("demo-synthetic");
    const vars = group.secrets.variables;
    expect(group.name).toBe("tessaloom-llm-limits");
    expect(group.restrictions).toMatchObject({
      restricted: true,
      nfObjects: [{ id: "tessaloom", type: "service" }],
    });
    expect(
      Object.keys(vars).filter((k) =>
        /KEY|SECRET|TOKEN|PEPPER|PASSWORD|DATABASE_URL|RUN_ACCESS/.test(k),
      ),
    ).toEqual([]);
    const worker = parseWorkerEnv({ ...demo, ...vars });
    expect(worker).toMatchObject({
      LLM_PROVIDER: "scripted",
      QLOO_MODE: "synthetic",
      GLOBAL_DAILY_LLM_USD: 0,
      WORKSPACE_DAILY_LLM_USD: 0,
      EXPERIMENT_LLM_USD: 0,
      GEMINI_MAX_REQUESTS: 0,
      GEMINI_LIVE_DATA_APPROVED: "off",
    });
    expect(parseWebEnv({ ...demo, ...vars })).toMatchObject({
      MAX_WORKING_RUNS: 4,
      MAX_ACTIVE_RUNS_PER_WORKSPACE: 1,
      WORKSPACE_DAILY_RUNS: 10,
    });
    // A stray provider key on the service is ignored: scripted never calls a paid API.
    expect(
      createLlmGateway(
        {
          ...worker,
          GEMINI_API_KEY: "sentinel",
          ANTHROPIC_API_KEY: "sentinel",
        },
        { record: async () => "id" },
      )?.providerName,
    ).toBe("scripted");
  });
  it("is refused if the service is still production or still live (half-applied change fails loudly)", () => {
    const vars = load("demo-synthetic").secrets.variables;
    expect(() =>
      parseWorkerEnv({ ...demo, ...vars, APP_ENV: "production" }),
    ).toThrow();
    expect(() =>
      parseWorkerEnv({
        ...demo,
        ...vars,
        APP_ENV: "production",
        QLOO_MODE: "live",
      }),
    ).toThrow("LLM_PROVIDER");
  });
});

describe("prepared paid judge demo group: Gemini 3.8 Flash on synthetic data (not applied)", () => {
  const demo = {
    ...base,
    APP_ENV: "staging",
    QLOO_MODE: "synthetic",
    RUN_ACCESS: "open",
  };
  it("is inert until the owner approves paid use, and never sends live data", async () => {
    const { createLlmGateway } = await import("../../apps/worker/src/llm");
    const vars = load("demo-gemini-flash").secrets.variables;
    const worker = parseWorkerEnv({ ...demo, ...vars });
    expect(worker).toMatchObject({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-3.8-flash",
      GEMINI_PAID_TIER_APPROVED: "off",
      GEMINI_LIVE_DATA_APPROVED: "off",
      GLOBAL_DAILY_LLM_USD: 1,
      WORKSPACE_DAILY_LLM_USD: 0.5,
      EXPERIMENT_LLM_USD: 0.5,
    });
    const keyed = { ...worker, GEMINI_API_KEY: "sentinel" };
    expect(createLlmGateway(keyed, { record: async () => "id" })).toBeNull();
    expect(
      createLlmGateway(
        {
          ...keyed,
          GEMINI_PAID_TIER_APPROVED: "on",
          GEMINI_PRICING_VERIFIED_AT: new Date().toISOString(),
        },
        { record: async () => "id" },
      )?.providerName,
    ).toBe("gemini");
    // Differs from the $0 demo only in provider, model, request cap, timeout and USD caps.
    const free = load("demo-synthetic").secrets.variables;
    expect(
      Object.keys({ ...vars, ...free })
        .filter((k) => vars[k] !== free[k])
        .sort(),
    ).toEqual(
      [
        "EXPERIMENT_LLM_USD",
        "GEMINI_MAX_REQUESTS",
        "GEMINI_TIMEOUT_MS",
        "GLOBAL_DAILY_LLM_USD",
        "LLM_FALLBACK_MODEL",
        "LLM_MODEL",
        "LLM_PROVIDER",
        "WORKSPACE_DAILY_LLM_USD",
      ].sort(),
    );
  });
});
