import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkQlooReadiness } from "../../packages/qloo-adapter/src/readiness";

const expectedBaseUrl = "https://hackathon.api.qloo.com";
const report = {
  status: "warning",
  versions: { harness: "0.1.26" },
  checks: [
    { id: "qloo-auth", status: "ok", message: "Credential present" },
    {
      id: "qloo-endpoint-trust",
      status: "ok",
      message: `Qloo API endpoint is explicitly trusted via QLOO_TRUSTED_BASE_URL: ${expectedBaseUrl}/`,
    },
    { id: "model-auth", status: "warning", message: "No model key" },
  ],
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function stub(body: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tl-readiness-"));
  dirs.push(dir);
  const command = path.join(dir, "qloo");
  const calls = path.join(dir, "calls.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\n${body}`,
  );
  await chmod(command, 0o755);
  return { command, calls };
}
const emit = (value: unknown) =>
  `console.log(${JSON.stringify(JSON.stringify(value))});`;

it("uses one offline doctor invocation for version and trust, accepting model-only warnings", async () => {
  const { command, calls } = await stub(`${emit(report)} process.exit(1);`);
  const result = await checkQlooReadiness({ expectedBaseUrl, command });
  expect(result).toMatchObject({
    ready: true,
    harnessVersion: "0.1.26",
    endpointTrusted: true,
  });
  expect((await readFile(calls, "utf8")).trim()).toBe('["doctor","--json"]');
});

it("rejects a killed probe even when it already emitted valid JSON", async () => {
  const { command, calls } = await stub(
    `${emit(report)} process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
  );
  const result = await checkQlooReadiness({
    expectedBaseUrl,
    command,
    timeoutMs: 1000,
  });
  expect(result).toMatchObject({
    ready: false,
    reason: "harness_unavailable",
    probeFailure: "timeout",
  });
  expect(result.probeDurationMs).toBeLessThan(3000);
  expect((await readFile(calls, "utf8")).trim()).toBe('["doctor","--json"]');
});

it("rejects unexpected exit codes even with a plausible doctor report", async () => {
  const { command } = await stub(`${emit(report)} process.exit(2);`);
  expect(await checkQlooReadiness({ expectedBaseUrl, command })).toMatchObject({
    ready: false,
    probeFailure: "process_failed",
  });
});

it.each([
  "not-json-secret-sentinel",
  JSON.stringify({ ...report, versions: { harness: "secret-sentinel" } }),
  "null",
])("rejects invalid output without exposing it %#", async (output) => {
  const { command } = await stub(`console.log(${JSON.stringify(output)});`);
  const result = await checkQlooReadiness({ expectedBaseUrl, command });
  expect(result).toMatchObject({
    ready: false,
    probeFailure: "invalid_report",
    harnessVersion: null,
  });
  expect(JSON.stringify(result)).not.toContain("secret-sentinel");
});

it("distinguishes a missing executable without exposing paths", async () => {
  const result = await checkQlooReadiness({
    expectedBaseUrl,
    command: "/missing/secret-sentinel/qloo",
  });
  expect(result).toMatchObject({ ready: false, probeFailure: "not_found" });
  expect(JSON.stringify(result)).not.toContain("secret-sentinel");
});

it("fails closed on a non-executable Harness without changing permissions", async () => {
  const { command } = await stub(emit(report));
  await chmod(command, 0o600);
  expect(await checkQlooReadiness({ expectedBaseUrl, command })).toMatchObject({
    ready: false,
    probeFailure: "permission_denied",
  });
});

it("rejects oversized output without leaking subprocess stdout or stderr", async () => {
  const { command } = await stub(
    `process.stderr.write('secret-sentinel'); process.stdout.write('secret-sentinel'.repeat(20000));`,
  );
  const result = await checkQlooReadiness({ expectedBaseUrl, command });
  expect(result).toMatchObject({ ready: false, probeFailure: "output_limit" });
  expect(JSON.stringify(result)).not.toContain("secret-sentinel");
});

it("rechecks after a transient invalid report rather than caching failure", async () => {
  const { command, calls } = await stub("");
  await writeFile(
    command,
    `#!/usr/bin/env node\nconst fs=require('node:fs'); const file=${JSON.stringify(calls)}; if(!fs.existsSync(file)){fs.writeFileSync(file,'first');console.log('invalid');}else{${emit(report)}}`,
  );
  expect(await checkQlooReadiness({ expectedBaseUrl, command })).toMatchObject({
    ready: false,
    probeFailure: "invalid_report",
  });
  expect(await checkQlooReadiness({ expectedBaseUrl, command })).toMatchObject({
    ready: true,
    harnessVersion: "0.1.26",
  });
});

it("requires the exact trusted endpoint rather than a URL prefix", async () => {
  const { command } = await stub(
    emit({
      ...report,
      checks: [
        report.checks[0],
        {
          ...report.checks[1],
          message: `Qloo API endpoint is official: ${expectedBaseUrl}.example.invalid/`,
        },
      ],
    }),
  );
  expect(await checkQlooReadiness({ expectedBaseUrl, command })).toMatchObject({
    ready: false,
    reason: "endpoint_not_trusted",
  });
});

it("does not pass database or model credentials to the probe", async () => {
  const { command } = await stub(
    `if(process.env.DATABASE_URL||process.env.ANTHROPIC_API_KEY||process.env.NODE_OPTIONS)process.exit(2); ${emit(report)}`,
  );
  expect(
    await checkQlooReadiness({
      expectedBaseUrl,
      command,
      env: {
        PATH: process.env.PATH,
        QLOO_API_KEY: "offline-test-sentinel",
        DATABASE_URL: "secret-sentinel",
        ANTHROPIC_API_KEY: "secret-sentinel",
        NODE_OPTIONS: "secret-sentinel",
      },
    }),
  ).toMatchObject({ ready: true });
});
