import { defineConfig, devices } from "@playwright/test";

// Browser E2E (TEST_PLAN §10) runs the production build in fixture mode: synthetic, labeled
// Qloo fixtures and the scripted AI stand-ins. The FIXTURE banner is asserted in every test.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e";

export default defineConfig({
  testDir: "./e2e",
  // Every test is one anonymous workspace from 127.0.0.1. The API's per-IP abuse limits
  // (SECURITY.md: 20 workspace creations and 20 run starts per minute) are kept as-is, so
  // local parallelism is capped to stay within them; CI runners use fewer workers anyway.
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "node scripts/e2e-db.mjs && node scripts/start.mjs",
    url: "http://127.0.0.1:3100/api/health/ready",
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    env: {
      TL_ROLE: "all",
      NODE_ENV: "production",
      APP_ENV: "test",
      PORT: "3100",
      HOSTNAME: "127.0.0.1",
      QLOO_MODE: "synthetic",
      LLM_PROVIDER: "scripted",
      DATABASE_URL,
      SESSION_SECRET: "playwright-placeholder-session-32-bytes",
      SHARE_TOKEN_PEPPER: "playwright-placeholder-pepper-32-bytes",
    },
  },
});
