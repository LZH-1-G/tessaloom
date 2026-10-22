import { createRedactor } from "../scripts/redact.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Creates only a uniquely named, disposable local Compose project. No external ACME/provider calls.
const securityOnly = process.env.DEPLOY_SECURITY_ONLY === "1";
const root = path.resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "tessaloom-deploy-smoke-"));
const project = `tl-deploy-${process.pid}-${Date.now()}`;
const privateDir = path.join(temporary, "private");
const image = process.env.M10B_IMAGE ?? "tessaloom:m10b";
const env = {
  ...process.env,
  APP_IMAGE: image,
  PRIVATE_DIR: privateDir,
  TLS_DOMAIN: "localhost",
  ACME_EMAIL: "test@example.invalid",
  BIND_IP: "127.0.0.1",
  HTTP_PORT: "0",
  HTTPS_PORT: "0",
  RUN_ACCESS: securityOnly ? "invite" : "off",
  GLOBAL_DAILY_LLM_USD: "0",
  GLOBAL_DAILY_QLOO_CALLS: "0",
};
const docker = (...args) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
const override = path.join(temporary, "override.json");
const composeArgs = [
  "compose",
  "-p",
  project,
  "-f",
  path.join(root, "deploy/compose.yml"),
  "-f",
  override,
];
const compose = (...args) => docker(...composeArgs, ...args);
const log = (event, details = {}) =>
  console.log(JSON.stringify({ event, ...details }));
let phase = "deployment_checks";
async function until(check, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* wait for readiness */
    }
    await delay(500);
  }
  throw new Error("Deployment smoke timed out");
}
const sql = (query, database = "tessaloom") =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    query,
  );
const client = `${project}-client`;
const clientScript = `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const lib = require(input.plain ? 'node:http' : 'node:https');
const req = lib.request({hostname:'proxy', port:input.plain ? 80 : 443, servername:'localhost', ca:fs.readFileSync('/tmp/https-ca.crt'), path:input.route, method:input.method, headers:{host:'localhost', ...input.headers}}, res=>{
  let text=''; res.setEncoding('utf8'); res.on('data', c=>text+=c);
  res.on('end', ()=>console.log(JSON.stringify({status:res.statusCode,headers:res.headers,text})));
});
req.setTimeout(10000,()=>req.destroy());
req.on('error',()=>{console.error('HTTPS client failed');process.exitCode=1});
if(input.body!==undefined) req.write(typeof input.body==='string'?input.body:JSON.stringify(input.body));
req.end();
`;
try {
  execFileSync(
    process.execPath,
    [path.join(root, "deploy/prepare.mjs"), privateDir],
    { stdio: "pipe" },
  );
  // Deliberately invalid test values. Both networks are internal before any container starts.
  writeFileSync(
    path.join(privateDir, "qloo_key"),
    "deployment-qloo-test-sentinel",
  );
  writeFileSync(
    path.join(privateDir, "anthropic_key"),
    "deployment-anthropic-test-sentinel",
  );
  const caddy = readFileSync(
    path.join(root, "deploy/Caddyfile"),
    "utf8",
  ).replace("{$TLS_DOMAIN} {", "{$TLS_DOMAIN} {\n\ttls internal");
  const caddyPath = path.join(temporary, "Caddyfile");
  writeFileSync(caddyPath, caddy);
  writeFileSync(
    override,
    JSON.stringify({
      networks: { outbound: { internal: true } },
      configs: { caddy: { file: caddyPath } },
    }),
  );
  const config = JSON.parse(compose("config", "--format", "json"));
  assert.equal(config.services.app.ports, undefined);
  assert.equal(config.services.postgres.ports, undefined);
  assert(config.services.proxy.ports.every((p) => p.host_ip === "127.0.0.1"));
  assert.equal(
    config.services.app.environment.RUN_ACCESS,
    securityOnly ? "invite" : "off",
  );
  assert.equal(config.services.app.environment.GLOBAL_DAILY_LLM_USD, "0");
  assert.equal(config.services.app.mem_limit, "2147483648");
  assert(config.networks.backend.internal && config.networks.outbound.internal);
  log("configuration_safe");
  compose("up", "-d", "--wait", "postgres");
  compose("run", "--rm", "migrate");
  if (!securityOnly) compose("run", "--rm", "migrate");
  assert.equal(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "8");
  assert.throws(() =>
    sql(
      "SET ROLE tessaloom_app; CREATE TABLE public.forbidden_deploy_test(id int)",
    ),
  );
  assert.throws(() =>
    compose("run", "--rm", "--no-deps", "-e", "RUN_ACCESS=open", "app"),
  );
  compose("up", "-d", "--wait", "app", "proxy");
  let appId = compose("ps", "-q", "app");
  const proxyId = compose("ps", "-q", "proxy");
  // File mounts must not circumvent the supervisor's worker-only environment boundary.
  for (const uid of [10001, 10002]) {
    for (const secret of [
      "app_password",
      "session_secret",
      "share_token_pepper",
      "qloo_key",
      "anthropic_key",
    ]) {
      docker(
        "exec",
        "--user",
        String(uid),
        appId,
        "node",
        "-e",
        `try { require('node:fs').readFileSync('/run/secrets/${secret}'); process.exit(1); } catch (e) { if (e.code !== 'EACCES') process.exit(2); }`,
      );
    }
  }
  log("secret_file_isolation_passed");
  for (const [uid, role] of [
    [10001, "web"],
    [10002, "worker"],
  ]) {
    const probe = `
const fs = require('node:fs'); let found = false;
for (const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))) {
  try {
    const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
    if (Number(status.match(/^Uid:\\s+(\\d+)/m)[1])!==process.getuid()) continue;
    const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
    if (${JSON.stringify(role)}==='web' ? !args[0]?.startsWith('next-server') : !args.some(a=>a.endsWith('apps/worker/dist/main.js'))) continue;
    const env=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').filter(Boolean).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
    const ok=${JSON.stringify(role)}==='worker' ? env.QLOO_API_KEY==='deployment-qloo-test-sentinel' && env.ANTHROPIC_API_KEY==='deployment-anthropic-test-sentinel' && !env.SESSION_SECRET && !env.SHARE_TOKEN_PEPPER : !env.QLOO_API_KEY && !env.ANTHROPIC_API_KEY && Boolean(env.SESSION_SECRET) && Boolean(env.SHARE_TOKEN_PEPPER);
    if(!ok || env.DATABASE_URL_MIGRATOR) process.exit(1);
    found=true;
  } catch(e) { if(!['ENOENT','ESRCH','EACCES'].includes(e.code)) throw e; }
}
if(!found) process.exit(2);
`;
    docker("exec", "--user", String(uid), appId, "node", "-e", probe);
  }
  log("web_worker_credential_environment_isolation_passed");
  assert.equal(
    docker("inspect", appId, "--format", "{{.HostConfig.Memory}}"),
    "2147483648",
  );
  assert.equal(
    docker("inspect", appId, "--format", "{{.HostConfig.MemorySwap}}"),
    "2147483648",
  );
  const appImage = docker(
    "image",
    "inspect",
    image,
    "--format",
    "{{.Os}}/{{.Architecture}}",
  );
  if (process.env.REQUIRE_ARM64 === "1") assert.equal(appImage, "linux/arm64");
  log("image_and_limits", {
    platform: appImage,
    appMiB: 2048,
    postgresMiB: 768,
    proxyMiB: 128,
  });
  const caPath = path.join(temporary, "https-ca.crt");
  docker("cp", `${proxyId}:/data/caddy/pki/authorities/local/root.crt`, caPath);
  docker(
    "run",
    "-d",
    "--name",
    client,
    "--network",
    `${project}_backend`,
    "--memory",
    "128m",
    "--entrypoint",
    "node",
    image,
    "-e",
    "setInterval(()=>{},1000)",
  );
  docker("cp", caPath, `${client}:/tmp/https-ca.crt`);
  const origin = "https://localhost";
  async function request(
    route,
    { method = "GET", headers = {}, body, plain = false } = {},
  ) {
    const result = execFileSync(
      "docker",
      ["exec", "-i", client, "node", "-e", clientScript],
      {
        input: JSON.stringify({ route, method, headers, body, plain }),
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return JSON.parse(result);
  }
  const redirect = await request("/", { plain: true });
  assert.equal(redirect.status, 308);
  assert.match(redirect.headers.location, /^https:\/\/localhost/);
  const ready = await request("/api/health/ready");
  assert.equal(ready.status, 200);
  assert.equal(
    sql(
      "SELECT bool_and(s.ssl) FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.usename='tessaloom_app'",
    ),
    "t",
  );
  assert.throws(() =>
    compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "postgresql://tessaloom_app@postgres/tessaloom?sslmode=disable",
      "-c",
      "SELECT 1",
    ),
  );
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers["strict-transport-security"], /max-age=/);
  assert.match(home.headers["content-security-policy"], /nonce-/);
  const workspace = await request("/api/v1/workspace");
  const cookies = workspace.headers["set-cookie"];
  assert(cookies.every((cookie) => /; Secure/i.test(cookie)));
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const csrf = cookies
    .find((c) => c.startsWith("tl_csrf="))
    .split(";")[0]
    .slice(8);
  const headers = {
    cookie,
    origin,
    "x-tessaloom-csrf": csrf,
    "content-type": "application/json",
  };
  const post = (route, body, more = {}) =>
    request(route, { method: "POST", headers: { ...headers, ...more }, body });
  const projectResponse = await post("/api/v1/projects", {
    name: "Deployment smoke",
    useCase: "cafe",
  });
  assert.equal(projectResponse.status, 201, `project: ${projectResponse.text}`);
  const projectId = JSON.parse(projectResponse.text).id;
  const brief = await post(`/api/v1/projects/${projectId}/briefs`, {
    title: "Local safety test",
    challenge: "Create a welcoming neighborhood gathering",
    interests: [{ text: "jazz" }, { text: "coffee" }],
    venue: { type: "cafe", capacity: 40 },
    goals: ["Welcome visitors"],
  });
  assert.equal(brief.status, 201, `brief: ${brief.text}`);
  if (!securityOnly) {
    const denied = await post(`/api/v1/projects/${projectId}/experiments`, {
      briefVersionId: JSON.parse(brief.text).id,
      mode: "live",
      variables: { collisionTension: 0.3 },
    });
    assert.equal(denied.status, 503);
    assert.equal(JSON.parse(denied.text).error.code, "PAID_RUNS_DISABLED");
    assert.equal(sql("SELECT count(*) FROM agent_runs"), "0");
    assert.equal(sql("SELECT count(*) FROM llm_spend_reservations"), "0");
    // New workspace each time defeats the workspace limiter; only the peer-IP limiter is shared.
    for (let i = 0; i < 11; i++) {
      const w = await request("/api/v1/workspace");
      const c = w.headers["set-cookie"];
      const result = await post(
        "/api/v1/workspace/access",
        { code: "invalid-deployment-code" },
        {
          cookie: c.map((v) => v.split(";")[0]).join("; "),
          "x-tessaloom-csrf": c
            .find((v) => v.startsWith("tl_csrf="))
            .split(";")[0]
            .slice(8),
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
      );
      assert.equal(result.status, i < 10 ? 400 : 429);
    }
    assert.equal(
      (await post("/api/v1/projects", "x".repeat(65_537))).status,
      413,
    );
    assert.equal((await request("/api/v1/samples")).status, 200);
    log("https_access_proxy_and_tls_passed");
  }
  env.RUN_ACCESS = "invite";
  if (!securityOnly) compose("up", "-d", "--force-recreate", "--wait", "app");
  appId = compose("ps", "-q", "app");
  await until(async () => (await request("/api/health/ready")).status === 200);
  const anonymousInvite = await post(
    `/api/v1/projects/${projectId}/experiments`,
    { briefVersionId: JSON.parse(brief.text).id, mode: "live" },
  );
  assert.equal(anonymousInvite.status, 403);
  assert.equal(
    JSON.parse(anonymousInvite.text).error.code,
    "RUN_ACCESS_REQUIRED",
  );
  assert.equal(sql("SELECT count(*) FROM agent_runs"), "0");
  assert.equal(sql("SELECT count(*) FROM llm_spend_reservations"), "0");
  log("production_invite_denial_passed");
  if (!securityOnly) {
    const backup = path.join(temporary, "backup.dump");
    execFileSync("bash", [path.join(root, "deploy/backup.sh"), backup], {
      env: { ...env, COMPOSE_PROJECT_NAME: project },
      stdio: "pipe",
    });
    sql("CREATE DATABASE tessaloom_restore");
    const dbId = compose("ps", "-q", "postgres");
    docker("cp", backup, `${dbId}:/tmp/restore.dump`);
    compose(
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "tessaloom_restore",
      "--exit-on-error",
      "--no-owner",
      "/tmp/restore.dump",
    );
    assert.equal(
      sql(
        "SELECT count(*) FROM drizzle.__drizzle_migrations",
        "tessaloom_restore",
      ),
      "8",
    );
    assert.equal(
      sql("SELECT name FROM projects", "tessaloom_restore"),
      "Deployment smoke",
    );
    // Recreation preserves the named PostgreSQL volume; no public ports or real provider credentials.
    compose("up", "-d", "--force-recreate", "--wait", "postgres");
    await until(
      async () => (await request("/api/health/ready")).status === 200,
    );
    assert.equal(sql("SELECT name FROM projects"), "Deployment smoke");
    compose("stop", "postgres");
    assert.equal((await request("/api/health/ready")).status, 503);
    assert.equal((await request("/api/health")).status, 200);
    compose("start", "postgres");
    await until(
      async () => (await request("/api/health/ready")).status === 200,
    );
    compose("stop", "app");
    const proxyFailure = await request(
      "/share/private-proxy-sentinel?code=private-query-sentinel",
      { headers: { authorization: "Bearer private-header-sentinel" } },
    );
    assert.equal(proxyFailure.status, 502);
    const proxyLogs = compose("logs", "--no-color", "proxy");
    for (const secret of [
      "private-proxy-sentinel",
      "private-query-sentinel",
      "private-header-sentinel",
    ])
      assert(!proxyLogs.includes(secret));
    compose("start", "app");
    await until(
      async () => (await request("/api/health/ready")).status === 200,
    );
    log("proxy_error_log_redaction_passed");
    // docker kill/stop is an operator stop and suppresses restart policy. Signal PID 1
    // from inside the container to exercise an actual process exit instead. Detach:
    // PID 1 exiting also kills exec processes, so an attached sender can return 137.
    phase = "container_restart_signal";
    const restartCount = () =>
      Number(docker("inspect", appId, "--format", "{{.RestartCount}}"));
    const restartsBefore = restartCount();
    log("container_restart_started", { restartsBefore });
    docker(
      "exec",
      "--detach",
      appId,
      "node",
      "-e",
      // Keep the sender alive to exercise Docker terminating it on container exit.
      "process.kill(1, 'SIGTERM'); setInterval(() => {}, 1000)",
    );
    phase = "container_restart_observed";
    // Readiness alone can still come from the old process during graceful shutdown.
    await until(() => restartCount() > restartsBefore);
    phase = "container_restart_https_ready";
    await until(
      async () => (await request("/api/health/ready")).status === 200,
    );
    assert.equal(sql("SELECT name FROM projects"), "Deployment smoke");
    assert(restartCount() > restartsBefore);
    log("container_restart_recovered", { restartsAfter: restartCount() });
    phase = "resource_snapshot";
    const stats = docker(
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}} {{.MemUsage}}",
      compose("ps", "-q", "app"),
      compose("ps", "-q", "postgres"),
      proxyId,
    );
    log("backup_persistence_restart_and_recovery_passed", {
      memorySnapshot: stats,
    });
    log("deployment_smoke_passed");
  } else {
    log("deployment_security_checks_passed");
  }
} catch (error) {
  const scrub = createRedactor(
    Object.fromEntries(
      [
        "postgres_password",
        "app_password",
        "migrator_password",
        "session_secret",
        "share_token_pepper",
      ].map((name) => [
        name,
        readFileSync(path.join(privateDir, name), "utf8").trim(),
      ]),
    ),
  );
  if (error.stderr) console.error(scrub(String(error.stderr)));
  try {
    console.error(
      scrub(
        compose(
          "logs",
          "--no-color",
          "--tail",
          "30",
          "postgres",
          "app",
          "proxy",
        ),
      ),
    );
  } catch {
    /* no containers yet */
  }
  // Only redacted diagnostics above; the failure summary never includes command arguments.
  console.error(
    JSON.stringify({
      event: "deployment_smoke_failed",
      phase,
      exitStatus: Number.isInteger(error.status) ? error.status : null,
      reason:
        error instanceof assert.AssertionError
          ? scrub(error.message)
          : "Local command failed; see redacted diagnostics",
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    docker("rm", "-f", client);
  } catch {
    /* client may not have started */
  }
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch {
    console.error(
      "Disposable smoke cleanup failed; inspect its uniquely named Compose project",
    );
    process.exitCode = 1;
  }
  rmSync(temporary, { recursive: true, force: true });
}
