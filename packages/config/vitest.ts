import { defineConfig } from "vitest/config";

export const unitConfig = defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,mjs}"],
    coverage: {
      provider: "v8",
      include: ["packages/config/env.ts", "scripts/start.mjs"],
      reporter: ["text", "json-summary", "html"],
    },
  },
});
