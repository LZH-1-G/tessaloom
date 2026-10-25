import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
it.each([
  { APP_ENV: "test", DATABASE_URL: "invalid-url-secret-sentinel" },
  {
    APP_ENV: "production",
    DATABASE_URL: "postgresql://user:secret-sentinel@localhost/db",
  },
  {
    APP_ENV: "production",
    DATABASE_URL:
      "postgresql://user:secret-sentinel@localhost/db?sslmode=verify-full&sslrootcert=/nonexistent/secret-sentinel",
  },
  { APP_ENV: "production" },
])(
  "the actual diagnostic CLI safely rejects invalid configuration %#",
  async (env) => {
    try {
      await run(process.execPath, ["packages/db/dist/diagnose.mjs"], {
        env: { ...env, PRIVATE_TOKEN: "secret-sentinel" },
        timeout: 8_000,
      });
      throw new Error("Diagnostic should fail");
    } catch (error) {
      const result = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("secret-sentinel");
      expect(result.stderr).not.toContain("postgresql://");
      expect(JSON.parse(result.stderr)).toMatchObject({
        event: "database_diagnostic_failed",
      });
    }
  },
);
