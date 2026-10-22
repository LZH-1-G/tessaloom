import { PassThrough } from "node:stream";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createRedactor, pipeRedactedLines } from "../../scripts/redact.mjs";
import {
  childHeapLimit,
  startSupervisor,
  validateSupervisorEnv,
} from "../../scripts/start.mjs";

const secret = 'test-secret-with-"-and-中文';
const env = {
  ANTHROPIC_API_KEY: secret,
  DATABASE_URL: "postgresql://owner:db-password@example.test/db",
};

describe("secret-safe supervised output", () => {
  it("redacts known, escaped and encoded secrets, URL credentials, auth and share tokens", () => {
    const redact = createRedactor(env);
    for (const value of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      "db-password",
      "Bearer private-token",
      "sk-ant-api03-unknown-key",
      "https://u:password@site.test/path",
      '"cookie":"tl_ws=private"',
      "/share/abcdefghijklmnopqrstuvwxyz0123456789",
    ])
      expect(redact(value)).not.toContain(value);
    expect(redact('{"event":"worker_started","pid":12}')).toBe(
      '{"event":"worker_started","pid":12}',
    );
  });
  it("handles split secrets, UTF-8, stderr fragments and a final unterminated line", async () => {
    const stream = new PassThrough();
    const lines = [];
    pipeRedactedLines(stream, (line) => lines.push(line), createRedactor(env));
    const bytes = Buffer.from(
      `prefix ${secret}\n中文\nBearer token-without-newline`,
    );
    for (const byte of bytes) stream.write(Buffer.from([byte]));
    stream.end();
    await once(stream, "end");
    expect(lines).toEqual(["prefix [REDACTED]", "中文", "Bearer [REDACTED]"]);
  });
  it("discards an entire oversized line without exposing a partial secret", async () => {
    const stream = new PassThrough();
    const lines = [];
    pipeRedactedLines(
      stream,
      (line) => lines.push(line),
      createRedactor(env),
      32,
    );
    stream.write("x".repeat(40));
    stream.write(secret);
    stream.end("\nnormal\n");
    await once(stream, "end");
    expect(lines).toEqual(["[oversized log line omitted]", "normal"]);
  });
  it("sets bounded heap flags and pipes both streams through the supervisor", async () => {
    const child = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let args, options;
    const logs = [];
    startSupervisor({
      env: { ...env, TL_ROLE: "worker", TL_WORKER_MAX_OLD_SPACE_MB: "640" },
      getuid: () => 501,
      spawnChild: (_exe, a, o) => {
        args = a;
        options = o;
        return child;
      },
      log: (entry) => logs.push(entry),
    });
    expect(args).toEqual([
      "--max-old-space-size=640",
      "apps/worker/dist/main.js",
    ]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    child.stdout.end(`${secret}\n`);
    child.stderr.end("Bearer unknown-token\n");
    await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
    const output = JSON.stringify(logs);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("unknown-token");
    expect(
      logs.filter((l) => l.event === "child_log").map((l) => l.stream),
    ).toEqual(["stdout", "stderr"]);
  });
  it("validates runtime requirements before spawning children", () => {
    const production = {
      APP_ENV: "production",
      QLOO_MODE: "live",
      DATABASE_URL: "postgresql://u:p@local/db?sslmode=require",
    };
    expect(validateSupervisorEnv(production)).toEqual(["web", "worker"]);
    for (const change of [
      { LLM_PROVIDER: "scripted" },
      { QLOO_MODE: undefined },
      { DATABASE_URL: "postgresql://u:p@local/db" },
      { TL_WEB_MAX_OLD_SPACE_MB: "--require=evil" },
    ])
      expect(() =>
        validateSupervisorEnv({ ...production, ...change }),
      ).toThrow();
    expect(childHeapLimit("web", {})).toBe(512);
    expect(childHeapLimit("worker", {})).toBe(768);
    for (const value of ["0", "127", "16385", "1.5", "Infinity"])
      expect(() =>
        childHeapLimit("web", { TL_WEB_MAX_OLD_SPACE_MB: value }),
      ).toThrow();
  });
});
