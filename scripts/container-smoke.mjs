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
      if (args[0]?.startsWith("next-server") || (args[0]?.includes("node") && args.some(arg => arg.endsWith("apps/worker/dist/main.js")))) {
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
    // TCP check: during initdb the temporary server listens only on the Unix socket.
    docker(
      "exec",
      db,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "tessaloom",
    ).includes("accepting connections"),
  );
  // M2: the image's release-step migrator applies the schema (forward-only, idempotent).
  const migrated = docker(
    "run",
    "--rm",
    "--network",
    network,
    "-e",
    "APP_ENV=test",
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
    "QLOO_MODE=synthetic",
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
    "GEMINI_API_KEY=live-gemini-secret-sentinel",
    "-e",
    "DEEPSEEK_API_KEY=live-deepseek-secret-sentinel",
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
  assert(worker.envNames.includes("GEMINI_API_KEY"));
  assert(worker.envNames.includes("DEEPSEEK_API_KEY"));
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
  // M4/M5: one run travels web → pg-boss → worker inside the image, with synthetic fixtures and
  // the scripted AI stand-ins, and pauses at gate H1 (brief confirmation).
  /** @param {string} query */
  const psql = (query) =>
    docker(
      "exec",
      db,
      "psql",
      "-U",
      "tessaloom",
      "-d",
      "tessaloom",
      "-tAc",
      query,
    );
  const workspaceResponse = await fetch(`${url}/api/v1/workspace`);
  assert.equal(workspaceResponse.status, 200);
  const cookies = workspaceResponse.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]);
  const csrf = String(
    cookies.find((cookie) => cookie?.startsWith("tl_csrf=")),
  ).slice("tl_csrf=".length);
  const { id: workspaceId } = /** @type {{ id: string }} */ (
    await workspaceResponse.json()
  );
  assert.match(workspaceId, /^[0-9a-f-]{36}$/);
  const projectId = psql(
    `INSERT INTO projects (id, workspace_id, name, use_case) VALUES (gen_random_uuid(), '${workspaceId}', 'Smoke', 'cafe') RETURNING id`,
  ).split("\n")[0];
  const brief = JSON.stringify({
    title: "Smoke brief",
    challenge: "A container smoke test brief with enough words.",
    interests: [{ text: "Alpha" }, { text: "Beta" }],
    venue: { type: "cafe" },
    constraints: {},
    goals: [],
  });
  const briefVersionId = psql(
    `INSERT INTO brief_versions (id, project_id, version, content, content_hash) VALUES (gen_random_uuid(), '${projectId}', 1, '${brief}'::jsonb, repeat('a', 64)) RETURNING id`,
  ).split("\n")[0];
  const host = new URL(url).host;
  const started = await fetch(
    `${url}/api/v1/projects/${projectId}/experiments`,
    {
      method: "POST",
      headers: {
        cookie: cookies.join("; "),
        origin: url,
        host,
        "x-tessaloom-csrf": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ briefVersionId, mode: "live" }),
    },
  );
  assert.equal(started.status, 202);
  const { runId, reused } = /** @type {{ runId: string; reused: boolean }} */ (
    await started.json()
  );
  assert.equal(reused, false);
  /** @type {{ state: string; terminalReason: string | null }} */
  let finalRun = { state: "QUEUED", terminalReason: null };
  await until(async () => {
    finalRun = /** @type {typeof finalRun} */ (
      await (
        await fetch(`${url}/api/v1/runs/${runId}`, {
          headers: { cookie: cookies.join("; ") },
        })
      ).json()
    );
    return finalRun.state === "AWAITING_BRIEF_CONFIRMATION";
  }, 30_000);
  assert.equal(finalRun.terminalReason, null);
  const sse = await (
    await fetch(`${url}/api/v1/runs/${runId}/events`, {
      headers: { cookie: cookies.join("; ") },
      signal: AbortSignal.timeout(10_000),
    })
  ).text();
  for (const type of ["RUN_STARTED", "STATE_ENTERED", "CONFIRMATION_REQUESTED"])
    assert(sse.includes(`"type":"${type}"`), `SSE stream lacks ${type}`);
  assert(sse.includes("event: run-terminal"));
  const mode = psql(
    `SELECT e.mode FROM experiments e JOIN agent_runs r ON r.experiment_id = e.id WHERE r.id = '${runId}'`,
  );
  assert.equal(mode, "fixture");
  log("run_queue_roundtrip_passed", { runId, state: finalRun.state });
  // Restore drill stays inside this run's disposable database container.
  docker(
    "exec",
    db,
    "pg_dump",
    "-U",
    "tessaloom",
    "-d",
    "tessaloom",
    "-Fc",
    "-f",
    "/tmp/m10-backup.dump",
  );
  docker("exec", db, "createdb", "-U", "tessaloom", "tessaloom_restore");
  docker(
    "exec",
    db,
    "pg_restore",
    "-U",
    "tessaloom",
    "--exit-on-error",
    "--no-owner",
    "-d",
    "tessaloom_restore",
    "/tmp/m10-backup.dump",
  );
  const restored = docker(
    "exec",
    db,
    "psql",
    "-U",
    "tessaloom",
    "-d",
    "tessaloom_restore",
    "-tAc",
    `SELECT state FROM agent_runs WHERE id = '${runId}'`,
  );
  assert.equal(restored, finalRun.state);
  assert.equal(
    docker(
      "exec",
      db,
      "psql",
      "-U",
      "tessaloom",
      "-d",
      "tessaloom_restore",
      "-tAc",
      "SELECT count(*) FROM drizzle.__drizzle_migrations",
    ),
    "8",
  );
  log("local_backup_restore_passed");
  // Exercise the packaged supervisor with a real OS child (same UID/env/pipe controls).
  // Node's child stdio uses sockets; reopening /proc/<pid>/fd/1 cannot inject into them.
  const redactionOutput = docker(
    "exec",
    app,
    "node",
    "--input-type=module",
    "-e",
    `
    import { spawn } from 'node:child_process';
    import { startSupervisor } from './scripts/start.mjs';
    const script = "process.stdout.write(process.env.QLOO_API_KEY.slice(0, 8)); setTimeout(() => { process.stdout.write(process.env.QLOO_API_KEY.slice(8) + String.fromCharCode(10)); console.error('Bearer smoke-private-token'); }, 10); setInterval(() => {}, 1000);";
    const seen = new Set();
    const supervisor = startSupervisor({
      env: { ...process.env, TL_ROLE: 'worker' },
      spawnChild: (exe, args, options) => spawn(exe, [args[0], '-e', script], options),
      log: entry => {
        console.log(JSON.stringify(entry));
        if (entry.event === 'child_log') seen.add(entry.stream);
        if (seen.size === 2) queueMicrotask(() => supervisor.shutdown());
      },
    });
    setTimeout(() => supervisor.shutdown('SIGTERM', 1), 5000).unref();
  `,
  );
  assert(!redactionOutput.includes("m0-qloo-secret-sentinel"));
  assert(!redactionOutput.includes("smoke-private-token"));
  assert(
    redactionOutput.includes("[REDACTED]"),
    "Redaction path was not exercised",
  );
  log("supervised_log_redaction_passed");
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
    "live-gemini-secret-sentinel",
    "live-deepseek-secret-sentinel",
    "m0-migrator-secret-sentinel",
  ]) {
    assert(!logs.includes(sentinel), "Secret value leaked to logs");
  }
  docker("stop", "--time", "10", db);
  await until(
    async () => (await fetch(`${url}/api/health/ready`)).status === 503,
  );
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  docker("start", db);
  await until(
    async () => (await fetch(`${url}/api/health/ready`)).status === 200,
  );
  log("readiness_outage_recovery_passed");
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
