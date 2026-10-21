import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:3100" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node scripts/start.mjs",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    env: {
      TL_ROLE: "all",
      NODE_ENV: "production",
      APP_ENV: "test",
      PORT: "3100",
      HOSTNAME: "127.0.0.1",
      QLOO_MODE: "fixture",
      LLM_PROVIDER: "scripted",
      DATABASE_URL: "postgresql://local:placeholder@127.0.0.1:5432/tessaloom",
      SESSION_SECRET: "playwright-placeholder-session-32-bytes",
      SHARE_TOKEN_PEPPER: "playwright-placeholder-pepper-32-bytes",
    },
  },
});
