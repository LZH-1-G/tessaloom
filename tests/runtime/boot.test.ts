import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const base = {
  NODE_ENV: "production",
  APP_ENV: "test",
  HOSTNAME: "127.0.0.1",
  PORT: "3199",
  DATABASE_URL: "postgresql://test:placeholder@127.0.0.1:5432/test",
  SESSION_SECRET: "runtime-session-placeholder-32-bytes",
  SHARE_TOKEN_PEPPER: "runtime-pepper-placeholder-32-bytes",
};

it.each(["QLOO_API_KEY", "ANTHROPIC_API_KEY", "OTHER_API_KEY"])(
  "the standalone web process exits for %s, without logging its value",
  async (key) => {
    try {
      await run(
        process.execPath,
        ["apps/web/.next/standalone/apps/web/server.js"],
        {
          env: { ...base, [key]: "m0-private-value-sentinel" },
          timeout: 5_000,
        },
      );
      throw new Error("Web process should reject provider credentials");
    } catch (error) {
      const result = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(key);
      expect(result.stdout + result.stderr).not.toContain(
        "m0-private-value-sentinel",
      );
    }
  },
);

it("the standalone web process refuses production fixtures", async () => {
  await expect(
    run(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"], {
      env: { ...base, APP_ENV: "production", QLOO_MODE: "fixture" },
      timeout: 5_000,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("QLOO_MODE"),
  });
});

it.each(["SIGTERM", "SIGINT"] as const)(
  "the keyless M0 worker stops cleanly on %s",
  async (signal) => {
    const child = spawn(process.execPath, ["apps/worker/dist/main.js"], {
      env: {
        APP_ENV: "production",
        NODE_ENV: "production",
        DATABASE_URL: base.DATABASE_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let signalSent = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      const result = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (!signalSent && output.includes("worker_started")) {
            signalSent = true;
            child.kill(signal);
          }
        });
        child.once("close", (code, exitSignal) =>
          resolve({ code, signal: exitSignal }),
        );
      });
      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toContain("worker_stopped");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);

/** Starts the standalone web server and returns the response headers of `paths`. */
async function headersFrom(
  env: Record<string, string>,
  paths: string[],
): Promise<Headers[]> {
  const port = String(3190 + Math.floor(Math.random() * 8));
  const child = spawn(
    process.execPath,
    ["apps/web/.next/standalone/apps/web/server.js"],
    { env: { ...base, ...env, PORT: port }, stdio: "ignore" },
  );
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const out: Headers[] = [];
        for (const p of paths)
          out.push((await fetch(`http://127.0.0.1:${port}${p}`)).headers);
        return out;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("web server did not start");
  } finally {
    child.kill("SIGTERM");
  }
}

it("serves CSP and security headers; HSTS only on HTTPS environments (SECURITY §7)", async () => {
  const [page, api, share] = await headersFrom(
    { APP_ENV: "production", QLOO_MODE: "live" },
    ["/", "/api/health", "/share/not-a-token"],
  );
  expect(page!.get("content-security-policy")).toMatch(
    /script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic';/,
  );
  expect(page!.get("content-security-policy")).toContain(
    "upgrade-insecure-requests",
  );
  for (const h of [page!, api!, share!]) {
    expect(h.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
  }
  expect(api!.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(share!.get("referrer-policy")).toBe("no-referrer");
  expect(share!.get("x-robots-tag")).toBe("noindex, nofollow");

  // Local HTTP test servers: same CSP, but no HSTS and no upgrade to HTTPS.
  const [local] = await headersFrom({ APP_ENV: "test" }, ["/"]);
  expect(local!.get("strict-transport-security")).toBeNull();
  expect(local!.get("content-security-policy")).not.toContain(
    "upgrade-insecure-requests",
  );
  expect(local!.get("content-security-policy")).toContain("'strict-dynamic'");
});
