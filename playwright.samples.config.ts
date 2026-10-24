import { defineConfig, devices } from "@playwright/test";

// Deliberately does not create/reset a database. Prepare the labelled local sample first.
const databaseUrl = process.env.E2E_SAMPLE_DATABASE_URL;
if (!databaseUrl) throw new Error("E2E_SAMPLE_DATABASE_URL is required");
const target = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/tessaloom_demo(?:_[a-z0-9_]+)?$/.test(target.pathname)
)
  throw new Error(
    "Read-only sample browser checks require a local demo database",
  );

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "test-results/samples",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3102", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node scripts/start.mjs",
    url: "http://127.0.0.1:3102/api/health/ready",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    env: {
      DATABASE_URL: databaseUrl,
      APP_ENV: "test",
      NODE_ENV: "production",
      TL_ROLE: "all",
      PORT: "3102",
      HOSTNAME: "127.0.0.1",
      RUN_ACCESS: "off",
      GLOBAL_DAILY_LLM_USD: "0",
      GLOBAL_DAILY_QLOO_CALLS: "0",
      QLOO_MODE: "synthetic",
      LLM_PROVIDER: "scripted",
      SESSION_SECRET: "sample-browser-placeholder-session-32-bytes",
      SHARE_TOKEN_PEPPER: "sample-browser-placeholder-pepper-32-bytes",
    },
  },
});
