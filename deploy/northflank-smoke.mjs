import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Real image CMD and environment injection, private PostgreSQL TLS, no provider egress.
const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "tl-northflank-"));
const project = `tl-nf-${process.pid}-${Date.now()}`;
const container = `${project}-app`;
const privateDir = path.join(temporary, "private");
const image = process.env.NF_IMAGE ?? "tessaloom:northflank-repair";
const env = {
  ...process.env,
  APP_IMAGE: image,
  PRIVATE_DIR: privateDir,
  TLS_DOMAIN: "proxy",
  ACME_EMAIL: "test@example.invalid",
};
const docker = (...args) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const override = path.join(temporary, "override.json");
const compose = (...args) =>
  docker(
    "compose",
    "-p",
    project,
    "-f",
    path.join(root, "deploy/compose.yml"),
    "-f",
    override,
    ...args,
  );
const log = (event, fields = {}) =>
  console.log(JSON.stringify({ event, ...fields }));
const sql = (query) =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "tessaloom",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    query,
  );
const probe = () =>
  JSON.parse(
    docker(
      "exec",
      container,
      "node",
      "-e",
      `fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(4500)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(1))`,
    ),
  );
async function until(check, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (check()) return;
    } catch {
      /* bounded startup */
    }
    await delay(1000);
  }
  throw new Error("Northflank local smoke timed out");
}
let phase = "prepare";
let peakBytes = 0;
function memory() {
  const bytes = Number(
    docker(
      "exec",
      container,
      "node",
      "-e",
      "console.log(require('node:fs').readFileSync('/sys/fs/cgroup/memory.peak','utf8'))",
    ),
  );
  peakBytes = Math.max(peakBytes, bytes);
}
try {
  execFileSync(
    process.execPath,
    [path.join(root, "deploy/prepare.mjs"), privateDir],
    { stdio: "pipe" },
  );
  // Exercise the exact managed-Postgres role bootstrap against this fresh disposable cluster.
  const init = path.join(temporary, "postgres-init.sh");
  writeFileSync(
    init,
    `#!/usr/bin/env bash
set -euo pipefail
export TL_APP_PASSWORD="$(cat /run/postgresql/tls/app_password)"
export TL_MIGRATOR_PASSWORD="$(cat /run/postgresql/tls/migrator_password)"
psql -v ON_ERROR_STOP=1 --username postgres --dbname tessaloom <<'SQL'
${readFileSync(path.join(root, "deploy/northflank-roles.sql"), "utf8")}
COMMENT ON DATABASE tessaloom IS 'tessaloom-bootstrap-v1-complete';
SQL
`,
  );
  writeFileSync(
    override,
    JSON.stringify({
      networks: { outbound: { internal: true } },
      configs: { pg_init: { file: init } },
    }),
  );
  compose("up", "-d", "postgres");
  await until(
    () =>
      sql(
        "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='tessaloom'",
      ) === "tessaloom-bootstrap-v1-complete",
  );
  const password = readFileSync(
    path.join(privateDir, "app_password"),
    "utf8",
  ).trim();
  const url = new URL("postgresql://tessaloom_app@postgres:5432/tessaloom");
  url.password = password;
  url.searchParams.set("sslmode", "require"); // compatibility normalization must retain verification
  url.searchParams.set("sslrootcert", "/run/tessaloom/db-ca.crt");
  const vars = {
    DATABASE_URL: url.toString(),
    APP_ENV: "production",
    NODE_ENV: "production",
    QLOO_MODE: "live",
    RUN_ACCESS: "off",
    GLOBAL_DAILY_LLM_USD: "0",
    GLOBAL_DAILY_QLOO_CALLS: "0",
    WORKSPACE_DAILY_LLM_USD: "0",
    EXPERIMENT_LLM_USD: "0",
    MAX_WORKING_RUNS: "1",
    TL_WEB_MAX_OLD_SPACE_MB: "128",
    TL_WORKER_MAX_OLD_SPACE_MB: "192",
    SESSION_SECRET: readFileSync(
      path.join(privateDir, "session_secret"),
      "utf8",
    ).trim(),
    SHARE_TOKEN_PEPPER: readFileSync(
      path.join(privateDir, "share_token_pepper"),
      "utf8",
    ).trim(),
  };
  const envFile = path.join(temporary, "runtime.env");
  writeFileSync(
    envFile,
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  phase = "unmigrated_startup";
  const started = Date.now();
  docker(
    "run",
    "-d",
    "--name",
    container,
    "--network",
    `${project}_backend`,
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "0.2",
    "--pids-limit",
    "256",
    "--security-opt",
    "no-new-privileges:true",
    "--env-file",
    envFile,
    "--mount",
    `type=bind,src=${privateDir}/db-ca.crt,dst=/run/tessaloom/db-ca.crt,readonly`,
    image,
  );
  const config = JSON.parse(docker("inspect", container))[0];
  assert.equal(config.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(config.HostConfig.NanoCpus, 200_000_000);
  assert.deepEqual(config.Config.Cmd, ["node", "scripts/start.mjs"]);
  assert.equal(
    config.HostConfig.PortBindings &&
      Object.keys(config.HostConfig.PortBindings).length,
    0,
  );
  await until(() => probe().status === 503);
  assert.deepEqual(probe(), { status: 503, body: { db: true, worker: false } });
  await until(() => docker("logs", container).includes("queue_schema_missing"));
  log("northflank_unmigrated_reproduced", {
    status: 503,
    reason: "queue_schema_missing",
  });
  phase = "release_migration";
  compose("--profile", "release", "run", "--rm", "migrate");
  compose("--profile", "release", "run", "--rm", "migrate");
  assert.equal(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "8");
  phase = "ready_after_migration";
  await until(() => probe().status === 200);
  assert.deepEqual(probe(), { status: 200, body: { db: true, worker: true } });
  const diagnostic = JSON.parse(
    docker("exec", container, "node", "packages/db/dist/diagnose.mjs"),
  );
  assert.equal(diagnostic.tls, true);
  assert.equal(diagnostic.elevated, false);
  assert.equal(diagnostic.schemaCreate, false);
  assert(Object.values(diagnostic.checks).every(Boolean));
  memory();
  log("northflank_ready_after_release", {
    startupAndMigrationMs: Date.now() - started,
    diagnostic,
  });
  phase = "bounded_request_load";
  docker(
    "exec",
    container,
    "node",
    "-e",
    `
    (async()=>{for(let n=0;n<4;n++) await Promise.all(['/', '/api/health', '/api/health/ready'].map(async p=>{
      const r=await fetch('http://127.0.0.1:3000'+p,{signal:AbortSignal.timeout(10000)});
      if(r.status!==200)throw Error('status'); await r.arrayBuffer();
    }));})().catch(()=>process.exit(1));`,
  );
  memory();
  const signalWorker = (signal) =>
    docker(
      "exec",
      container,
      "node",
      "-e",
      `
    const fs=require('node:fs'); for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){
      try {const args=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');
      if(args.includes('apps/worker/dist/main.js')){process.kill(Number(p),'${signal}');process.exit(0)}}catch{}}
    process.exit(1);`,
    );
  phase = "stale_and_other_instance_heartbeat";
  signalWorker("SIGSTOP");
  sql(
    "INSERT INTO worker_heartbeats(worker_id,last_beat_at,qloo_ready) VALUES('other-pod',now(),false)",
  );
  await delay(35_000);
  sql(
    "UPDATE worker_heartbeats SET last_beat_at=now() WHERE worker_id='other-pod'",
  );
  assert.deepEqual(probe(), { status: 503, body: { db: true, worker: false } });
  signalWorker("SIGCONT");
  await until(() => probe().status === 200);
  log("northflank_scoped_readiness_passed");
  phase = "database_restart";
  compose("restart", "postgres");
  await until(() => probe().status === 200);
  assert.equal(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "8");
  memory();
  const logs = docker("logs", container);
  for (const value of [
    password,
    vars.SESSION_SECRET,
    vars.SHARE_TOKEN_PEPPER,
    url.toString(),
  ])
    assert(!logs.includes(value));
  assert(!logs.includes("SecurityWarning"));
  phase = "shutdown";
  docker("stop", "--time", "35", container);
  const state = JSON.parse(docker("inspect", container))[0].State;
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  assert(docker("logs", container).includes("worker_stopped"));
  log("northflank_local_smoke_passed", {
    memoryLimitMiB: 512,
    cpu: 0.2,
    peakMemoryMiB: Math.round((peakBytes / 1024 / 1024) * 10) / 10,
    paidOrQlooCalls: 0,
    publicPorts: 0,
    exitCode: state.ExitCode,
  });
} catch {
  // Captured subprocess errors may contain environment or DB credentials. Never print them.
  log("northflank_local_smoke_failed", { phase });
  process.exitCode = 1;
} finally {
  try {
    docker("rm", "-f", container);
  } catch {
    /* absent */
  }
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch {
    log("northflank_cleanup_failed");
    process.exitCode = 1;
  }
  rmSync(temporary, { recursive: true, force: true });
}
