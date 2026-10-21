import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const image = process.env.M0_IMAGE ?? "tessaloom:m0";
const suffix = `${process.pid}-${Date.now()}`;
const network = `tl-m0-${suffix}`;
const db = `${network}-db`;
const app = `${network}-app`;
/** @param {...string} args */
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
/** @param {string} event @param {Record<string, unknown>} details */
const log = (event, details = {}) =>
  console.log(JSON.stringify({ event, ...details }));

/** @param {() => boolean | Promise<boolean>} check @param {number} timeoutMs */
async function until(check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error("Smoke check timed out", { cause: lastError });
}

const inspectScript = `
  const fs = require("node:fs");
  const rows = [];
  for (const pid of fs.readdirSync("/proc").filter(p => /^\\d+$/.test(p))) {
    try {
      const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0");
      const command = args.join(" ");
      if (args[0]?.startsWith("next-server") || (args[0]?.includes("node") && args[1]?.endsWith("apps/worker/dist/main.js"))) {
        const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
        const uid = Number(status.match(/^Uid:\\s+(\\d+)/m)[1]);
        if (uid !== process.getuid()) continue;
        const env = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\\0").filter(Boolean);
        rows.push({ pid: Number(pid), role: command.includes("next-server") ? "web" : "worker",
          uid, gid: Number(status.match(/^Gid:\\s+(\\d+)/m)[1]), envNames: env.map(v => v.slice(0, v.indexOf("="))).sort() });
      }
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  const home = fs.statSync("/home/tl-worker/.qloo");
  console.log(JSON.stringify({ rows, home: { uid: home.uid, mode: home.mode & 511 } }));
`;

function inspectProcesses() {
  // Default Docker capabilities do not let root inspect a different UID's
  // environment. Read each process as its own UID without adding capabilities.
  /** @typedef {{pid: number, role: string, uid: number, gid: number, envNames: string[]}} ProcessRow */
  /** @type {{rows: ProcessRow[], home: {uid: number, mode: number}}[]} */
  const states = [10001, 10002].map((uid) =>
    JSON.parse(
      docker(
        "exec",
        "--user",
        `${uid}:${uid}`,
        app,
        "node",
        "-e",
        inspectScript,
      ),
    ),
  );
  assert(states[1]);
  return { rows: states.flatMap((state) => state.rows), home: states[1].home };
}

try {
  const version = docker("run", "--rm", image, "qloo", "--version");
  assert.match(version, /0\.1\.26/);
  log("harness_version", { version });
  docker("network", "create", network);
  docker(
    "run",
    "-d",
    "--name",
    db,
    "--network",
    network,
    "-e",
    "POSTGRES_USER=tessaloom",
    "-e",
    "POSTGRES_PASSWORD=local-development-only",
    "-e",
    "POSTGRES_DB=tessaloom",
    "postgres:16",
  );
  await until(() =>
    docker("exec", db, "pg_isready", "-U", "tessaloom").includes(
      "accepting connections",
    ),
  );
  // M2: the image's release-step migrator applies the schema (forward-only, idempotent).
  const migrated = docker(
    "run",
    "--rm",
    "--network",
    network,
    "-e",
    `DATABASE_URL_MIGRATOR=postgresql://tessaloom:local-development-only@${db}:5432/tessaloom`,
    image,
    "node",
    "packages/db/dist/migrate.mjs",
  );
  assert.match(migrated, /"event":"migrations_applied"/);
  log("image_migrations_applied");
  docker(
    "run",
    "-d",
    "--name",
    app,
    "--network",
    network,
    "-p",
    "127.0.0.1::3000",
    "-e",
    "APP_ENV=test",
    "-e",
    "QLOO_MODE=fixture",
    "-e",
    "LLM_PROVIDER=scripted",
    "-e",
    `DATABASE_URL=postgresql://tessaloom:local-development-only@${db}:5432/tessaloom`,
    "-e",
    "SESSION_SECRET=m0-placeholder-session-at-least-32-bytes",
    "-e",
    "SHARE_TOKEN_PEPPER=m0-placeholder-pepper-at-least-32-bytes",
    "-e",
    "QLOO_API_KEY=m0-qloo-secret-sentinel",
    "-e",
    "ANTHROPIC_API_KEY=m0-llm-secret-sentinel",
    "-e",
    "DATABASE_URL_MIGRATOR=m0-migrator-secret-sentinel",
    image,
  );
  const port = docker("port", app, "3000/tcp").split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  await until(
    async () =>
      (
        await fetch(`${url}/api/health/ready`, {
          signal: AbortSignal.timeout(3_000),
        })
      ).status === 200,
  );
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const first = inspectProcesses();
  assert.equal(first.rows.length, 2);
  const web = first.rows.find((row) => row.role === "web");
  const worker = first.rows.find((row) => row.role === "worker");
  assert(web && worker);
  assert.equal(web.uid, 10001);
  assert.equal(worker.uid, 10002);
  assert.equal(web.gid, 10001);
  assert.equal(worker.gid, 10002);
  assert.equal(first.home.uid, 10002);
  assert.equal(first.home.mode, 0o700);
  assert(
    !web.envNames.some(
      (name) =>
        name.endsWith("_API_KEY") ||
        name.startsWith("QLOO_") ||
        name === "DATABASE_URL_MIGRATOR",
    ),
  );
  assert(worker.envNames.includes("QLOO_API_KEY"));
  assert(worker.envNames.includes("ANTHROPIC_API_KEY"));
  assert(
    !worker.envNames.some((name) =>
      [
        "SESSION_SECRET",
        "SHARE_TOKEN_PEPPER",
        "DATABASE_URL_MIGRATOR",
      ].includes(name),
    ),
  );
  log("process_isolation_passed", first);
  const harness = JSON.parse(
    docker(
      "exec",
      "--user",
      `${worker.uid}:${worker.gid}`,
      app,
      "/usr/local/bin/node",
      "-e",
      `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const { execFileSync, spawnSync } = require("node:child_process");
      assert.equal(process.getuid(), ${worker.uid});
      assert.equal(process.getgid(), ${worker.gid});
      // Read the live supervised worker's environment under its actual UID.
      // Never reconstruct it from buildChildEnv or inherit docker exec's PATH.
      const entries = fs.readFileSync("/proc/${worker.pid}/environ", "utf8").split("\\0").filter(Boolean);
      const env = Object.fromEntries(entries.map(v => { const at = v.indexOf("="); return [v.slice(0, at), v.slice(at + 1)]; }));
      assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
      const withoutPath = { ...env };
      delete withoutPath.PATH;
      assert.equal(spawnSync("qloo", ["--version"], { env: withoutPath }).error?.code, "ENOENT");
      assert.match(fs.readFileSync("/usr/local/bin/qloo", "utf8").split("\\n")[0], /^#!\\s*\\/usr\\/bin\\/env node\\s*$/);
      const version = execFileSync("qloo", ["--version"], { env, encoding: "utf8", timeout: 15000 }).trim();
      assert.equal(version, "0.1.26");
      // M2/ADR-019: the supervised worker environment trusts exactly the hackathon endpoint (local check, no network).
      assert.equal(env.QLOO_BASE_URL, "https://hackathon.api.qloo.com");
      const doctor = JSON.parse(spawnSync("qloo", ["doctor", "--json"], { env, encoding: "utf8", timeout: 15000 }).stdout);
      const trust = doctor.checks.find((c) => c.id === "qloo-endpoint-trust");
      assert.equal(trust.status, "ok");
      assert.ok(trust.message.includes("explicitly trusted via QLOO_TRUSTED_BASE_URL: https://hackathon.api.qloo.com/"));
      console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), version, nodeShebangExecuted: true, missingPathRejected: true, hackathonEndpointTrusted: true }));
    `,
    ),
  );
  log("supervised_worker_harness_passed", harness);
  // M2: the supervised worker reaches PostgreSQL and records its heartbeat.
  await until(
    () =>
      Number(
        docker(
          "exec",
          db,
          "psql",
          "-U",
          "tessaloom",
          "-d",
          "tessaloom",
          "-tAc",
          "SELECT count(*) FROM worker_heartbeats WHERE last_beat_at > now() - interval '1 minute'",
        ),
      ) >= 1,
    20_000,
  );
  log("worker_heartbeat_passed");
  docker(
    "exec",
    "--user",
    "10001:10001",
    app,
    "node",
    "-e",
    `try { require("node:fs").readFileSync("/proc/${worker.pid}/environ"); process.exit(1); } catch (e) { if (e.code !== "EACCES") throw e; }`,
  );
  docker(
    "exec",
    "--user",
    "10001:10001",
    app,
    "node",
    "-e",
    'try { require("node:fs").readdirSync("/home/tl-worker/.qloo"); process.exit(1); } catch (e) { if (e.code !== "EACCES") throw e; }',
  );
  log("web_worker_access_denied", { environment: true, harnessHome: true });
  const killedAt = Date.now();
  docker("exec", app, "node", "-e", `process.kill(${worker.pid}, "SIGKILL")`);
  await until(async () => {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    const state = inspectProcesses();
    return state.rows.some(
      (row) => row.role === "worker" && row.pid !== worker.pid,
    );
  }, 5_000);
  log("worker_restart_passed", { elapsedMs: Date.now() - killedAt });
  const captured = spawnSync("docker", ["logs", app], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(captured.status, 0);
  const logs = captured.stdout + captured.stderr;
  for (const sentinel of [
    "m0-qloo-secret-sentinel",
    "m0-llm-secret-sentinel",
    "m0-migrator-secret-sentinel",
  ]) {
    assert(!logs.includes(sentinel), "Secret value leaked to logs");
  }
  docker("stop", "--time", "30", app);
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", app), "0");
  log("graceful_shutdown_passed");
  const rejected = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-e",
      "APP_ENV=production",
      "-e",
      "QLOO_MODE=fixture",
      "-e",
      "TL_ROLE=web",
      image,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(rejected.status, 1, "Production fixtures were accepted");
  assert.match(
    rejected.stderr,
    /"event":"supervisor_config_invalid","reason":"production_fixture_forbidden"/,
  );
  assert(!rejected.stdout.includes('"event":"child_start"'));
  log("production_fixture_guard_passed");
  for (const [role, variable] of /** @type {const} */ ([
    ["web", "TL_WEB_UID"],
    ["worker", "TL_WORKER_UID"],
  ])) {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-e",
        `TL_ROLE=${role}`,
        image,
        "/usr/bin/env",
        "-u",
        variable,
        "/usr/local/bin/node",
        "scripts/start.mjs",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /"event":"supervisor_config_invalid","reason":"invalid_configuration"/,
    );
    assert(!result.stdout.includes('"event":"child_start"'));
  }
  log("root_identity_fail_closed_passed");
  log("container_smoke_passed");
} finally {
  for (const name of [app, db]) {
    try {
      docker("rm", "-f", "-v", name);
    } catch {
      /* Only this run's resources. */
    }
  }
  try {
    docker("network", "rm", network);
  } catch {
    /* May not have been created. */
  }
}
