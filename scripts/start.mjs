import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor, pipeRedactedLines } from "./redact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Trust the running interpreter's directory and fixed system executable paths,
// never a parent PATH (which may contain writable or relative entries).
export const CHILD_PATH = [
  ...new Set([
    path.dirname(process.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]),
].join(path.delimiter);
/** @typedef {Record<string, string | undefined>} Environment */
/** @typedef {"web" | "worker"} ChildRole */
const common = [
  "NODE_ENV",
  "APP_ENV",
  "DATABASE_URL",
  "LOG_LEVEL",
  "RUN_ACCESS",
  "TL_HEARTBEAT_ID",
];
const allowlists = {
  web: [
    ...common,
    "PORT",
    "HOSTNAME",
    "SESSION_SECRET",
    "SHARE_TOKEN_PEPPER",
    "ADMIN_TOKEN",
    "TRUSTED_PROXY_HOPS",
    // M10-A run admission limits.
    "MAX_ACTIVE_RUNS_PER_WORKSPACE",
    "MAX_WORKING_RUNS",
    "WORKSPACE_DAILY_RUNS",
  ],
  worker: [
    ...common,
    "QLOO_API_KEY",
    "QLOO_HOME",
    "QLOO_MODE",
    "QLOO_RATE_LIMIT_PER_MIN",
    // Non-secret hackathon endpoint settings (V1/ADR-019); the harness refuses an untrusted URL.
    "QLOO_BASE_URL",
    "QLOO_TRUSTED_BASE_URL",
    "QLOO_RAW_RETENTION",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_LIVE_APPROVED",
    "DEEPSEEK_MAX_REQUESTS",
    "DEEPSEEK_BUDGET_CNY",
    "DEEPSEEK_USD_PER_CNY",
    "DEEPSEEK_PRICING_VERIFIED_AT",
    "GEMINI_FREE_TIER_CONFIRMED",
    "GEMINI_DATA_SHARING_APPROVED",
    "GEMINI_MAX_REQUESTS",
    "GEMINI_TIMEOUT_MS",
    "CLAUDE_SUBSCRIPTION_LOCAL_APPROVED",
    "CLAUDE_SUBSCRIPTION_MAX_REQUESTS",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_FALLBACK_MODEL",
    "LLM_MODE",
    // M10-A spend ledger caps (GLOBAL_DAILY_* are matched by pattern below).
    "WORKSPACE_DAILY_LLM_USD",
    "EXPERIMENT_LLM_USD",
  ],
};

/** @param {ChildRole} role @param {Environment} env */
export function buildChildEnv(role, env) {
  if (!Object.hasOwn(allowlists, role)) throw new Error("Invalid child role");
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) =>
          value !== undefined &&
          (allowlists[role].includes(key) ||
            (role === "worker" && /^GLOBAL_DAILY_[A-Z0-9_]+$/.test(key))),
      ),
    ),
    // Local subscription mode: the Claude Code child finds the owner's own login via HOME.
    ...(role === "worker" && localSubscriptionMode(env)
      ? Object.fromEntries(
          ["HOME", "USER", "LOGNAME", "TMPDIR"]
            .filter((key) => env[key])
            .map((key) => [key, env[key]]),
        )
      : {}),
    PATH: CHILD_PATH,
  };
}

/** @param {Environment} env */
function localSubscriptionMode(env) {
  return (
    env.LLM_PROVIDER === "claude-subscription" &&
    (env.APP_ENV === "development" || env.APP_ENV === "test")
  );
}

/** @param {Environment} env @returns {ChildRole[]} */
export function validateSupervisorEnv(env) {
  const role = env.TL_ROLE ?? "all";
  if (!["all", "web", "worker"].includes(role))
    throw new Error("Invalid TL_ROLE");
  if (
    env.APP_ENV === "production" &&
    (env.QLOO_MODE === "fixture" || env.QLOO_MODE === "synthetic")
  ) {
    throw new Error("Invalid QLOO_MODE: fixtures are forbidden in production");
  }
  if (env.LLM_PROVIDER === "claude-subscription" && !localSubscriptionMode(env))
    throw new Error("Invalid LLM_PROVIDER: subscription mode is local only");
  if (env.APP_ENV === "production") {
    if (env.QLOO_MODE !== "live") throw new Error("Invalid QLOO_MODE");
    if (env.LLM_PROVIDER === "scripted")
      throw new Error("Invalid LLM_PROVIDER");
  }
  if (env.APP_ENV === "production" || env.APP_ENV === "staging") {
    let valid = false;
    try {
      const url = new URL(env.DATABASE_URL ?? "");
      const modes = url.searchParams.getAll("sslmode");
      valid =
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        modes.length === 1 &&
        ["require", "verify-ca", "verify-full"].includes(modes[0] ?? "") &&
        !url.searchParams.has("ssl") &&
        !url.searchParams.has("uselibpqcompat");
    } catch {
      /* Report variable names only. */
    }
    if (!valid) throw new Error("Invalid DATABASE_URL: TLS is required");
  }
  for (const role of ["web", "worker"]) childHeapLimit(role, env);
  for (const key of [
    "TL_WEB_UID",
    "TL_WEB_GID",
    "TL_WORKER_UID",
    "TL_WORKER_GID",
  ]) {
    if (
      env[key] !== undefined &&
      (!/^[1-9]\d*$/.test(env[key]) || !Number.isSafeInteger(Number(env[key])))
    ) {
      throw new Error(`Invalid ${key}`);
    }
  }
  return role === "all" ? ["web", "worker"] : [/** @type {ChildRole} */ (role)];
}

/** @param {string} role @param {Environment} env */
export function childHeapLimit(role, env) {
  const key = `TL_${role.toUpperCase()}_MAX_OLD_SPACE_MB`;
  const value = env[key] ?? (role === "web" ? "512" : "768");
  if (!/^\d+$/.test(value) || Number(value) < 128 || Number(value) > 16_384)
    throw new Error(`Invalid ${key}`);
  return Number(value);
}

/** @param {ChildRole} role @param {Environment} env @param {(() => number) | undefined} getuid */
export function childIdentity(role, env, getuid = process.getuid) {
  if (getuid?.() !== 0) return {};
  const prefix = `TL_${role.toUpperCase()}`;
  const uid = Number(env[`${prefix}_UID`]);
  const gid = Number(env[`${prefix}_GID`] ?? uid);
  for (const [key, value] of [
    [`${prefix}_UID`, uid],
    [`${prefix}_GID`, gid],
  ]) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value >= 0xffffffff
    ) {
      throw new Error(
        `Invalid ${key}: root requires a non-root child identity`,
      );
    }
  }
  return { uid, gid };
}

/** @param {number} crashCount */
export function restartDelay(crashCount) {
  return Math.min(1_000 * 2 ** (crashCount - 1), 30_000);
}

/**
 * @typedef {object} SupervisorOptions
 * @property {Environment} [env]
 * @property {typeof spawn} [spawnChild]
 * @property {(entry: Record<string, unknown>) => void} [log]
 * @property {(code: number) => void} [exit]
 * @property {() => number} [now]
 * @property {() => number} [getuid]
 * @property {(child: import("node:child_process").ChildProcess, signal: NodeJS.Signals) => void} [signalChild]
 */
/** @param {SupervisorOptions} options */
export function startSupervisor({
  env = process.env,
  spawnChild = spawn,
  log: emitLog = (entry) => console.log(JSON.stringify(entry)),
  exit = (code) => process.exit(code),
  now = Date.now,
  getuid = process.getuid,
  signalChild = (child, signal) => {
    try {
      // Each child owns a process group, so future harness descendants stop too.
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  },
} = {}) {
  const roles = validateSupervisorEnv(env);
  // Each colocated web/worker pair gets its own readiness identity, including during rollouts.
  if (roles.length === 2) env = { ...env, TL_HEARTBEAT_ID: randomUUID() };
  const redact = createRedactor(env);
  /** @param {unknown} value @returns {unknown} */
  const scrub = (value) =>
    typeof value === "string"
      ? redact(value)
      : Array.isArray(value)
        ? value.map(scrub)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, field]) => [key, scrub(field)]),
            )
          : value;
  /** @param {Record<string, unknown>} entry */
  const log = (entry) =>
    emitLog(/** @type {Record<string, unknown>} */ (scrub(entry)));
  // Validate every selected identity before spawning any child, outside the
  // restart handler. Misconfiguration must never launch a root child.
  const identities = new Map(
    roles.map((role) => [role, childIdentity(role, env, getuid)]),
  );
  if (
    getuid?.() === 0 &&
    roles.length === 2 &&
    identities.get("web")?.uid === identities.get("worker")?.uid
  ) {
    throw new Error("TL_WEB_UID and TL_WORKER_UID must be distinct");
  }
  /** @type {Map<ChildRole, import("node:child_process").ChildProcess>} */
  const children = new Map();
  /** @type {Map<ChildRole, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {Map<ChildRole, number>} */
  const streaks = new Map();
  /** @type {number[]} */
  let crashes = [];
  let stopping = false;
  let finished = false;
  let exitCode = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let graceTimer;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(graceTimer);
    exit(exitCode);
  }

  /** @param {NodeJS.Signals} signal @param {number} code */
  function shutdown(signal = "SIGTERM", code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const child of children.values()) signalChild(child, signal);
    if (children.size === 0) return finish();
    graceTimer = setTimeout(() => {
      for (const child of children.values()) signalChild(child, "SIGKILL");
      finish();
    }, 25_000);
  }

  /** @param {ChildRole} role */
  function launch(role) {
    if (stopping) return;
    const childEnv = buildChildEnv(role, env);
    log({ event: "child_start", role, envNames: Object.keys(childEnv).sort() });
    const webFile = existsSync(path.join(root, "apps/web/server.js"))
      ? "apps/web/server.js"
      : "apps/web/.next/standalone/apps/web/server.js";
    const file = role === "web" ? webFile : "apps/worker/dist/main.js";
    const startedAt = now();
    let child;
    let settled = false;

    function stopped() {
      if (settled) return;
      settled = true;
      children.delete(role);
      if (stopping) {
        if (children.size === 0) finish();
        return;
      }
      crashes = crashes.filter((at) => now() - at < 300_000);
      crashes.push(now());
      if (crashes.length > 5) {
        log({ event: "crash_limit", role });
        shutdown("SIGTERM", 1);
        return;
      }
      const count =
        now() - startedAt >= 300_000 ? 1 : (streaks.get(role) ?? 0) + 1;
      streaks.set(role, count);
      const delayMs = restartDelay(count);
      log({ event: "child_restart", role, delayMs });
      timers.set(
        role,
        setTimeout(() => {
          timers.delete(role);
          launch(role);
        }, delayMs),
      );
    }

    try {
      child = spawnChild(
        process.execPath,
        [`--max-old-space-size=${childHeapLimit(role, env)}`, file],
        {
          cwd: root,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          ...identities.get(role),
        },
      );
      children.set(role, child);
      for (const [stream, output] of /** @type {const} */ ([
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ]))
        pipeRedactedLines(
          output,
          (message) => log({ event: "child_log", role, stream, message }),
          redact,
        );
      child.once("error", stopped);
      child.once("exit", stopped);
    } catch {
      stopped();
    }
  }

  for (const role of roles) launch(role);
  return { shutdown };
}

/** @param {unknown} error */
export function supervisorFailure(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Invalid QLOO_MODE: fixtures are forbidden in production")
    return { reason: "production_fixture_forbidden", variable: "QLOO_MODE" };
  for (const variable of [
    "TL_ROLE",
    "QLOO_MODE",
    "LLM_PROVIDER",
    "DATABASE_URL",
    "TL_WEB_UID",
    "TL_WEB_GID",
    "TL_WORKER_UID",
    "TL_WORKER_GID",
    "TL_WEB_MAX_OLD_SPACE_MB",
    "TL_WORKER_MAX_OLD_SPACE_MB",
  ]) {
    if (
      message === `Invalid ${variable}` ||
      message.startsWith(`Invalid ${variable}:`)
    )
      return { reason: "invalid_configuration", variable };
  }
  if (message === "TL_WEB_UID and TL_WORKER_UID must be distinct")
    return { reason: "child_identities_must_differ" };
  return { reason: "invalid_configuration" };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const supervisor = startSupervisor();
    process.on("SIGTERM", () => supervisor.shutdown("SIGTERM"));
    process.on("SIGINT", () => supervisor.shutdown("SIGINT"));
  } catch (error) {
    // Configuration values and raw child errors are deliberately never logged.
    console.error(
      JSON.stringify({
        event: "supervisor_config_invalid",
        ...supervisorFailure(error),
      }),
    );
    process.exitCode = 1;
  }
}
