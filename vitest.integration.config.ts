import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 20_000,
    // Each file creates and migrates its own database.
    hookTimeout: 60_000,
  },
});
