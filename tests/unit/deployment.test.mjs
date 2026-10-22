import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAccessFor } from "../../packages/config/env";

describe("deployment preparation safeguards", () => {
  it("denies anonymous production/staging runs by default and preserves the kill switch", () => {
    expect(runAccessFor("production")).toBe("invite");
    expect(runAccessFor("staging")).toBe("invite");
    expect(runAccessFor("production", "off")).toBe("off");
    expect(runAccessFor("test")).toBe("open");
  });
  it("creates private keyless credentials and hostname-verified TLS without overwriting existing secrets", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "tl-prepare-test-"));
    const destination = path.join(parent, "private");
    try {
      execFileSync(process.execPath, ["deploy/prepare.mjs", destination], {
        stdio: "pipe",
      });
      const password = readFileSync(
        path.join(destination, "app_password"),
        "utf8",
      );
      expect(password.trim()).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(destination).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(destination, "db.key")).mode & 0o777).toBe(
        0o600,
      );
      expect(
        statSync(path.join(destination, "app_password")).mode & 0o777,
      ).toBe(0o600);
      expect(
        readFileSync(path.join(destination, "anthropic_key"), "utf8"),
      ).toBe("");
      expect(readFileSync(path.join(destination, "qloo_key"), "utf8")).toBe("");
      const verify = (hostname) =>
        spawnSync(
          "openssl",
          [
            "verify",
            "-CAfile",
            "db-ca.crt",
            "-verify_hostname",
            hostname,
            "db.crt",
          ],
          { cwd: destination, stdio: "pipe" },
        );
      expect(verify("postgres").status).toBe(0);
      expect(verify("attacker.invalid").status).not.toBe(0);
      expect(
        spawnSync(process.execPath, ["deploy/prepare.mjs", destination], {
          stdio: "pipe",
        }).status,
      ).not.toBe(0);
      expect(readFileSync(path.join(destination, "app_password"), "utf8")).toBe(
        password,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
