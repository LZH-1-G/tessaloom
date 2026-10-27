import { z } from "zod";

const postgresUrl = z
  .string()
  .url()
  .refine(
    (value) => /^postgres(?:ql)?:\/\//.test(value),
    "Expected a PostgreSQL URL",
  );

const shared = {
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: postgresUrl,
  TL_HEARTBEAT_ID: z.string().uuid().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // synthetic: deterministic generated fixtures for development and browser E2E (ADR-024).
  QLOO_MODE: z.enum(["fixture", "synthetic", "live"]).optional(),
  // M10-A cost safety: who may start paid AI work. Unset → `invite` on staging/production
  // (anonymous visitors cannot spend), `open` on development/test. `off` = kill switch.
  RUN_ACCESS: z.enum(["off", "invite", "open"]).optional(),
};

/** The effective RUN_ACCESS: explicit value, else fail-closed for deployed environments. */
export const runAccessFor = (
  appEnv: string,
  value?: "off" | "invite" | "open",
): "off" | "invite" | "open" =>
  value ??
  (appEnv === "staging" || appEnv === "production" ? "invite" : "open");

function fixtureGuard(
  value: { APP_ENV: string; QLOO_MODE?: string; DATABASE_URL: string },
  ctx: z.RefinementCtx,
) {
  if (!databaseTlsAllowed(value.APP_ENV, value.DATABASE_URL))
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "Database TLS is required",
    });
  if (
    value.APP_ENV === "production" &&
    (value.QLOO_MODE === "fixture" || value.QLOO_MODE === "synthetic")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QLOO_MODE"],
      message: "Fixtures are forbidden in production",
    });
  }
}

/** Explicit TLS only; reject duplicate/conflicting options rather than relying on driver precedence. */
export function databaseTlsAllowed(
  appEnv: string | undefined,
  value: string,
): boolean {
  if (appEnv !== "production" && appEnv !== "staging") return true;
  try {
    const url = new URL(value);
    const modes = url.searchParams.getAll("sslmode");
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      modes.length === 1 &&
      ["require", "verify-ca", "verify-full"].includes(modes[0] ?? "") &&
      !url.searchParams.has("ssl") &&
      !url.searchParams.has("uselibpqcompat")
    );
  } catch {
    return false;
  }
}

/** Preserve pg 8's certificate + hostname verification when pg 9 changes sslmode semantics. */
export function verifiedDatabaseUrl(value: string): string {
  const url = new URL(value);
  const modes = url.searchParams.getAll("sslmode");
  if (
    modes.length === 1 &&
    ["require", "verify-ca"].includes(modes[0] ?? "") &&
    !url.searchParams.has("ssl") &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  }
  return value;
}

// Inspect the original environment before Zod strips unknown variables.
export const webEnvSchema = z
  .record(z.string(), z.unknown())
  .superRefine((env, ctx) => {
    for (const key of Object.keys(env)) {
      if (key.endsWith("_API_KEY") || key === "DATABASE_URL_MIGRATOR") {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Forbidden web environment variable",
        });
      }
    }
  })
  .pipe(
    z
      .object({
        ...shared,
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),
        HOSTNAME: z.string().min(1).default("0.0.0.0"),
        SESSION_SECRET: z.string().min(32),
        SHARE_TOKEN_PEPPER: z.string().min(32),
        ADMIN_TOKEN: z.string().min(32).optional(),
        TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
        // M10-A run admission (job-creation limits; see packages/db repositories/cost.ts).
        MAX_ACTIVE_RUNS_PER_WORKSPACE: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .default(3),
        MAX_WORKING_RUNS: z.coerce.number().int().min(1).max(100).default(6),
        WORKSPACE_DAILY_RUNS: z.coerce
          .number()
          .int()
          .min(1)
          .max(500)
          .default(20),
      })
      .superRefine(fixtureGuard),
  );

export const workerEnvSchema = z
  .object({
    ...shared,
    // M0 never constructs adapters or calls providers. Key requirements belong to M2/M3.
    QLOO_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    DEEPSEEK_API_KEY: z.string().min(1).optional(),
    DEEPSEEK_LIVE_APPROVED: z.enum(["off", "on"]).default("off"),
    DEEPSEEK_MAX_REQUESTS: z.coerce.number().int().min(0).max(4).default(0),
    DEEPSEEK_BUDGET_CNY: z.coerce.number().min(0).max(2).default(0),
    DEEPSEEK_USD_PER_CNY: z.coerce.number().positive().max(1).optional(),
    DEEPSEEK_PRICING_VERIFIED_AT: z.string().datetime().optional(),
    GEMINI_FREE_TIER_CONFIRMED: z.enum(["off", "on"]).default("off"),
    GEMINI_DATA_SHARING_APPROVED: z.enum(["off", "on"]).default("off"),
    // Paid Tier: explicit billing approval plus the owner's dated check of the price table.
    GEMINI_PAID_TIER_APPROVED: z.enum(["off", "on"]).default("off"),
    GEMINI_PRICING_VERIFIED_AT: z.string().datetime().optional(),
    // Verified permission to send live, Qloo-derived inputs to Gemini (paid tier only).
    GEMINI_LIVE_DATA_APPROVED: z.enum(["off", "on"]).default("off"),
    // Free tier: per worker lifetime, at most 50. Paid tier: per UTC day, per worker process.
    GEMINI_MAX_REQUESTS: z.coerce.number().int().min(0).max(5000).default(0),
    GEMINI_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(120_000)
      .default(60_000),
    QLOO_HOME: z.string().min(1).optional(),
    // V1: the hackathon endpoint requires both variables, set to the same exact URL.
    QLOO_BASE_URL: z.string().url().startsWith("https://").optional(),
    QLOO_TRUSTED_BASE_URL: z.string().url().startsWith("https://").optional(),
    // Raw Qloo payloads are not persisted until storage permission is confirmed (R-08).
    QLOO_RAW_RETENTION: z.enum(["off", "on"]).default("off"),
    QLOO_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
    GLOBAL_DAILY_QLOO_CALLS: z.coerce.number().int().nonnegative().default(300),
    GLOBAL_DAILY_LLM_USD: z.coerce.number().nonnegative().default(15),
    // M10-A spend ledger caps (USD). Every paid attempt reserves against all of them.
    WORKSPACE_DAILY_LLM_USD: z.coerce.number().nonnegative().default(3),
    EXPERIMENT_LLM_USD: z.coerce.number().nonnegative().default(5),
    LLM_PROVIDER: z
      .enum([
        "anthropic",
        "scripted",
        "gemini",
        "deepseek",
        "claude-subscription",
      ])
      .default("anthropic"),
    // Local personal use only: the owner's own Claude Code login, never a public deployment.
    CLAUDE_SUBSCRIPTION_LOCAL_APPROVED: z.enum(["off", "on"]).default("off"),
    CLAUDE_SUBSCRIPTION_MAX_REQUESTS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30)
      .default(0),
    LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
    LLM_FALLBACK_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
    // economy: every step uses LLM_FALLBACK_MODEL (ADR-018).
    LLM_MODE: z.enum(["standard", "economy"]).default("standard"),
  })
  .superRefine(fixtureGuard)
  .superRefine((value, ctx) => {
    if (value.APP_ENV === "production" && value.QLOO_MODE !== "live")
      ctx.addIssue({
        code: "custom",
        path: ["QLOO_MODE"],
        message: "Production requires live mode",
      });
    // Anthropic does not permit routing other users' requests through a personal plan.
    if (
      value.LLM_PROVIDER === "claude-subscription" &&
      !["development", "test"].includes(value.APP_ENV)
    )
      ctx.addIssue({
        code: "custom",
        path: ["LLM_PROVIDER"],
        message: "Claude subscription mode is local personal use only",
      });
    if (value.LLM_PROVIDER === "claude-subscription" && value.ANTHROPIC_API_KEY)
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "Subscription mode must not run beside an API key",
      });
    if (
      value.GEMINI_FREE_TIER_CONFIRMED === "on" &&
      value.GEMINI_PAID_TIER_APPROVED === "on"
    )
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_PAID_TIER_APPROVED"],
        message: "Choose exactly one Gemini billing tier",
      });
    if (
      value.GEMINI_FREE_TIER_CONFIRMED === "on" &&
      value.GEMINI_MAX_REQUESTS > 50
    )
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_MAX_REQUESTS"],
        message: "The Gemini free tier is capped at 50 requests",
      });
    if (
      value.GEMINI_PAID_TIER_APPROVED === "on" &&
      !value.GEMINI_PRICING_VERIFIED_AT
    )
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_PRICING_VERIFIED_AT"],
        message: "Paid Gemini requires a dated pricing review",
      });
    // Free-tier inputs may be used by Google to improve its products.
    if (
      value.GEMINI_LIVE_DATA_APPROVED === "on" &&
      value.GEMINI_PAID_TIER_APPROVED !== "on"
    )
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_LIVE_DATA_APPROVED"],
        message: "Live data may only be sent to the paid Gemini tier",
      });
    if (
      value.APP_ENV === "production" &&
      value.LLM_PROVIDER === "gemini" &&
      value.GEMINI_FREE_TIER_CONFIRMED === "on"
    )
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_FREE_TIER_CONFIRMED"],
        message: "The Gemini free tier is not a production configuration",
      });
    // Scripted LLM output is test data; like fixtures it must never reach production users.
    if (value.APP_ENV === "production" && value.LLM_PROVIDER === "scripted") {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_PROVIDER"],
        message: "The scripted LLM provider is forbidden in production",
      });
    }
  })
  .superRefine((value, ctx) => {
    const normalize = (url?: string) => url?.replace(/\/+$/, "");
    if (
      value.QLOO_BASE_URL &&
      normalize(value.QLOO_BASE_URL) !== normalize(value.QLOO_TRUSTED_BASE_URL)
    ) {
      // The harness refuses a custom base URL unless it is explicitly trusted.
      ctx.addIssue({
        code: "custom",
        path: ["QLOO_TRUSTED_BASE_URL"],
        message: "QLOO_TRUSTED_BASE_URL must equal QLOO_BASE_URL",
      });
    }
  });

// Do not expose Zod's raw errors: future validators may include input values.
function parseEnv<T>(schema: z.ZodType<T>, env: Record<string, unknown>): T {
  // Node's process.env has an exotic prototype; validate a plain snapshot.
  const parsed = schema.safeParse({ ...env });
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(`Invalid environment variables: ${names.join(", ")}`);
  }
  return parsed.data;
}

export const parseWebEnv = (env: Record<string, unknown>) =>
  parseEnv(webEnvSchema, env);
export const parseWorkerEnv = (env: Record<string, unknown>) =>
  parseEnv(workerEnvSchema, env);
