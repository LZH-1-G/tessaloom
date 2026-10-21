import { defineConfig } from "drizzle-kit";

// Generation needs no database connection; migrations are applied by src/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  verbose: false,
});
