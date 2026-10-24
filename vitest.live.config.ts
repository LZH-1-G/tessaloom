import { defineConfig } from "vitest/config";

// Explicit command only. No retries/repeats or public CI, even with accidentally injected keys.
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  process.env.LIVE_VALIDATION_APPROVED !== "yes" ||
  !["gemini", "qloo"].includes(process.env.LIVE_VALIDATION_PROVIDER ?? "")
)
  throw new Error(
    "Live provider tests require explicit local approval and are forbidden in CI",
  );
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 90_000,
  },
});
