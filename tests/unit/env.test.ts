import { describe, expect, it } from "vitest";
import {
  parseWebEnv,
  parseWorkerEnv,
  webEnvSchema,
  workerEnvSchema,
} from "../../packages/config/env";

const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://local:placeholder@localhost:5432/tessaloom",
  SESSION_SECRET: "test-session-placeholder-at-least-32-bytes",
  SHARE_TOKEN_PEPPER: "test-pepper-placeholder-at-least-32-bytes",
};

describe("environment isolation", () => {
  it("accepts an environment with Node's process.env prototype", () => {
    const env = Object.assign(
      Object.create(Object.getPrototypeOf(process.env)),
      base,
    );
    expect(parseWebEnv(env).APP_ENV).toBe("test");
    expect(() =>
      parseWebEnv(Object.assign(env, { QLOO_API_KEY: "dummy-secret" })),
    ).toThrow("QLOO_API_KEY");
  });
  it.each([
    "QLOO_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NEXT_PUBLIC_VENDOR_API_KEY",
    "DATABASE_URL_MIGRATOR",
  ])("rejects %s even when empty", (key) => {
    expect(
      webEnvSchema.safeParse({ ...base, [key]: "dummy-secret" }).success,
    ).toBe(false);
    expect(webEnvSchema.safeParse({ ...base, [key]: "" }).success).toBe(false);
  });
  it.each([webEnvSchema, workerEnvSchema])(
    "rejects production fixtures",
    (schema) => {
      expect(
        schema.safeParse({
          ...base,
          APP_ENV: "production",
          QLOO_MODE: "fixture",
        }).success,
      ).toBe(false);
    },
  );
  it("accepts development fixtures and keyless production M0 lifecycle", () => {
    expect(parseWorkerEnv({ ...base, QLOO_MODE: "fixture" }).QLOO_MODE).toBe(
      "fixture",
    );
    expect(
      parseWorkerEnv({ ...base, APP_ENV: "production", QLOO_MODE: "live" })
        .LLM_MODEL,
    ).toBe("claude-opus-5-5");
    expect(parseWebEnv({ ...base, APP_ENV: "production" }).PORT).toBe(3000);
  });
  it("strips unrelated fields and keeps the fallback model", () => {
    const parsed = parseWorkerEnv({ ...base, UNKNOWN: "discard" });
    expect(parsed).not.toHaveProperty("SESSION_SECRET");
    expect(parsed).not.toHaveProperty("UNKNOWN");
    expect(parsed.LLM_FALLBACK_MODEL).toBe("claude-sonnet-5-5");
  });
  it.each([
    { DATABASE_URL: "https://example.com" },
    { DATABASE_URL: "invalid" },
    { APP_ENV: undefined },
    { PORT: "0" },
    { PORT: "65536" },
    { SESSION_SECRET: "short" },
  ])("rejects invalid web configuration %j", (change) => {
    expect(webEnvSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });
  it("reports variable names without secret values", () => {
    expect(() =>
      parseWebEnv({ ...base, ANTHROPIC_API_KEY: "sensitive-sentinel" }),
    ).toThrow("ANTHROPIC_API_KEY");
    const parseInvalidWorkerEnv = () =>
      parseWorkerEnv({ ...base, DATABASE_URL: "sensitive-sentinel" });
    expect(parseInvalidWorkerEnv).toThrow("DATABASE_URL");
    expect(parseInvalidWorkerEnv).not.toThrow("sensitive-sentinel");
  });
});

describe("hackathon endpoint settings (V1, ADR-019)", () => {
  const live = { ...base, QLOO_MODE: "live" };
  it("accepts matching base and trusted URLs and defaults raw retention to off", () => {
    const parsed = parseWorkerEnv({
      ...live,
      QLOO_BASE_URL: "https://hackathon.api.qloo.com",
      QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com/",
    });
    expect(parsed.QLOO_RAW_RETENTION).toBe("off");
  });
  it.each([
    { QLOO_BASE_URL: "https://hackathon.api.qloo.com" },
    {
      QLOO_BASE_URL: "https://hackathon.api.qloo.com",
      QLOO_TRUSTED_BASE_URL: "https://api.qloo.com",
    },
    {
      QLOO_BASE_URL: "http://hackathon.api.qloo.com",
      QLOO_TRUSTED_BASE_URL: "http://hackathon.api.qloo.com",
    },
    { QLOO_RAW_RETENTION: "always" },
  ])("rejects unsafe endpoint configuration %j", (change) => {
    expect(workerEnvSchema.safeParse({ ...live, ...change }).success).toBe(
      false,
    );
  });
});
