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
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  QLOO_MODE: z.enum(["fixture", "live"]).optional(),
};

function fixtureGuard(
  value: { APP_ENV: string; QLOO_MODE?: string },
  ctx: z.RefinementCtx,
) {
  if (value.APP_ENV === "production" && value.QLOO_MODE === "fixture") {
    ctx.addIssue({
      code: "custom",
      path: ["QLOO_MODE"],
      message: "Fixtures are forbidden in production",
    });
  }
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
      })
      .superRefine(fixtureGuard),
  );

export const workerEnvSchema = z
  .object({
    ...shared,
    // M0 never constructs adapters or calls providers. Key requirements belong to M2/M3.
    QLOO_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    QLOO_HOME: z.string().min(1).optional(),
    // V1: the hackathon endpoint requires both variables, set to the same exact URL.
    QLOO_BASE_URL: z.string().url().startsWith("https://").optional(),
    QLOO_TRUSTED_BASE_URL: z.string().url().startsWith("https://").optional(),
    // Raw Qloo payloads are not persisted until storage permission is confirmed (R-08).
    QLOO_RAW_RETENTION: z.enum(["off", "on"]).default("off"),
    QLOO_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
    GLOBAL_DAILY_QLOO_CALLS: z.coerce.number().int().nonnegative().default(300),
    GLOBAL_DAILY_LLM_USD: z.coerce.number().nonnegative().default(15),
    LLM_PROVIDER: z.enum(["anthropic", "scripted"]).default("anthropic"),
    LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
    LLM_FALLBACK_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  })
  .superRefine(fixtureGuard)
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
