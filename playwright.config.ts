import { defineConfig, devices } from "@playwright/test";

// Browser E2E (TEST_PLAN §10) runs the production build in fixture mode: synthetic, labeled
// Qloo fixtures and the scripted AI stand-ins. The FIXTURE banner is asserted in every test.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://tessaloom:local-development-only@127.0.0.1:5432/tessaloom_e2e${process.env.INVITE_E2E ? "_invite" : ""}`;
const invite = process.env.INVITE_E2E === "1";
const port = invite ? "3101" : "3100";

export default defineConfig({
  testDir: "./e2e",
  ...(invite
    ? { testMatch: "**/m10-invite.spec.ts" }
    : { testIgnore: "**/m10-invite.spec.ts" }),
  // Every test is one anonymous workspace from 127.0.0.1. The API's per-IP abuse limits
  // (SECURITY.md: 20 workspace creations and 20 run starts per minute) are kept as-is, so
  // local parallelism is capped to stay within them; CI runners use fewer workers anyway.
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
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
    url: `http://127.0.0.1:${port}/api/health/ready`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    env: {
      TL_ROLE: "all",
      NODE_ENV: "production",
      APP_ENV: "test",
      PORT: port,
      HOSTNAME: "127.0.0.1",
      QLOO_MODE: "synthetic",
      LLM_PROVIDER: "scripted",
      RUN_ACCESS: invite ? "invite" : "open",
      TRUSTED_PROXY_HOPS: "1",
      DATABASE_URL,
      SESSION_SECRET: "playwright-placeholder-session-32-bytes",
      SHARE_TOKEN_PEPPER: "playwright-placeholder-pepper-32-bytes",
      // M10-A admission: parallel E2E workers run many journeys at once. The global
      // working-run limit is exercised by the integration tests, not by browser timing.
      MAX_WORKING_RUNS: "40",
    },
  },
});
