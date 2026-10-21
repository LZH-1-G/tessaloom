import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChildEnv,
  CHILD_PATH,
  childIdentity,
  restartDelay,
  startSupervisor,
  validateSupervisorEnv,
} from "../../scripts/start.mjs";

const fullEnv = {
  NODE_ENV: "production",
  APP_ENV: "test",
  PORT: "3000",
  HOSTNAME: "0.0.0.0",
  DATABASE_URL: "database-sentinel",
  SESSION_SECRET: "session-sentinel",
  SHARE_TOKEN_PEPPER: "pepper-sentinel",
  ADMIN_TOKEN: "admin-sentinel",
  QLOO_API_KEY: "qloo-sentinel",
  QLOO_HOME: "/worker",
  QLOO_MODE: "fixture",
  ANTHROPIC_API_KEY: "llm-sentinel",
  OPENAI_API_KEY: "unknown-provider",
  DATABASE_URL_MIGRATOR: "migrator-sentinel",
  UNKNOWN: "unknown",
  NODE_OPTIONS: "--require=/untrusted",
  PATH: "/attacker/bin:.:/tmp",
  LD_PRELOAD: "/untrusted/library.so",
  GLOBAL_DAILY_QLOO_CALLS: "300",
  GLOBAL_DAILY_LLM_USD: "15",
  QLOO_RATE_LIMIT_PER_MIN: "20",
  LOG_LEVEL: "info",
  LLM_PROVIDER: "scripted",
  LLM_MODEL: "primary",
  LLM_FALLBACK_MODEL: "fallback",
  QLOO_BASE_URL: "https://hackathon.api.qloo.com",
  QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com",
  QLOO_RAW_RETENTION: "off",
};

describe("child environment", () => {
  it("passes exactly the web allowlist", () => {
    expect(Object.keys(buildChildEnv("web", fullEnv)).sort()).toEqual(
      [
        "NODE_ENV",
        "APP_ENV",
        "PORT",
        "HOSTNAME",
        "DATABASE_URL",
        "SESSION_SECRET",
        "SHARE_TOKEN_PEPPER",
        "ADMIN_TOKEN",
        "LOG_LEVEL",
        "PATH",
      ].sort(),
    );
  });
  it("passes exactly the worker allowlist", () => {
    expect(Object.keys(buildChildEnv("worker", fullEnv)).sort()).toEqual(
      [
        "NODE_ENV",
        "APP_ENV",
        "DATABASE_URL",
        "QLOO_API_KEY",
        "QLOO_HOME",
        "QLOO_MODE",
        "ANTHROPIC_API_KEY",
        "GLOBAL_DAILY_QLOO_CALLS",
        "GLOBAL_DAILY_LLM_USD",
        "QLOO_RATE_LIMIT_PER_MIN",
        "LOG_LEVEL",
        "LLM_PROVIDER",
        "LLM_MODEL",
        "LLM_FALLBACK_MODEL",
        "QLOO_BASE_URL",
        "QLOO_TRUSTED_BASE_URL",
        "QLOO_RAW_RETENTION",
        "PATH",
      ].sort(),
    );
  });
  it("drops undefined values and rejects unknown roles", () => {
    expect(buildChildEnv("web", { PORT: undefined })).toEqual({
      PATH: CHILD_PATH,
    });
    expect(() => buildChildEnv("other", {})).toThrow();
  });
  it.each(["web", "worker"])("supplies a controlled PATH for %s", (role) => {
    const childEnv = buildChildEnv(role, fullEnv);
    expect(childEnv.PATH).toBe(CHILD_PATH);
    expect(CHILD_PATH.split(path.delimiter)).toEqual([
      ...new Set([
        path.dirname(process.execPath),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]),
    ]);
    expect(childEnv.PATH).not.toContain("/attacker");
    expect(childEnv).not.toHaveProperty("LD_PRELOAD");
    expect(childEnv).not.toHaveProperty("NODE_OPTIONS");
    expect(buildChildEnv(role, {}).PATH).toBe(CHILD_PATH);
  });
  it("checks production fixtures before the web allowlist strips QLOO_MODE", () => {
    expect(() =>
      validateSupervisorEnv({
        APP_ENV: "production",
        QLOO_MODE: "fixture",
        TL_ROLE: "web",
      }),
    ).toThrow();
  });
  it.each(["all", "web", "worker"])("supports role %s", (role) => {
    expect(validateSupervisorEnv({ TL_ROLE: role })).toEqual(
      role === "all" ? ["web", "worker"] : [role],
    );
  });
  it("rejects invalid role and UID without echoing values", () => {
    expect(() => validateSupervisorEnv({ TL_ROLE: "secret-value" })).toThrow(
      "Invalid TL_ROLE",
    );
    for (const uid of ["0", "-1", "nan", "1.5"]) {
      expect(() => validateSupervisorEnv({ TL_WEB_UID: uid })).toThrow(
        "Invalid TL_WEB_UID",
      );
    }
  });
  it("drops UIDs only for a root supervisor", () => {
    const env = { TL_WEB_UID: "10001", TL_WEB_GID: "10003" };
    expect(childIdentity("web", env, () => 0)).toEqual({
      uid: 10001,
      gid: 10003,
    });
    expect(childIdentity("web", { TL_WEB_UID: "10001" }, () => 0)).toEqual({
      uid: 10001,
      gid: 10001,
    });
    expect(childIdentity("web", env, () => 501)).toEqual({});
    expect(() => childIdentity("web", {}, () => 0)).toThrow("TL_WEB_UID");
    expect(childIdentity("worker", {}, () => 501)).toEqual({});
  });
});

describe("supervisor lifecycle", () => {
  let children, spawnChild, log, exit, signalChild;
  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawnChild = vi.fn(() => {
      const child = new EventEmitter();
      child.pid = children.length + 100;
      children.push(child);
      return child;
    });
    log = vi.fn();
    exit = vi.fn();
    signalChild = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const options = () => ({
    env: fullEnv,
    spawnChild,
    log,
    exit,
    signalChild,
    getuid: () => 501,
  });
  it.each([
    { TL_ROLE: "web" },
    { TL_ROLE: "worker" },
    { TL_WEB_UID: "10001" },
    { TL_WORKER_UID: "10002" },
    { TL_WEB_UID: "10001", TL_WORKER_UID: "10001" },
    { TL_ROLE: "web", TL_WEB_UID: "0" },
    { TL_ROLE: "web", TL_WEB_UID: "4294967295" },
    { TL_ROLE: "web", TL_WEB_UID: "10001", TL_WEB_GID: "0" },
  ])(
    "rejects unsafe root identities before spawning any child: %j",
    (config) => {
      expect(() =>
        startSupervisor({
          ...options(),
          env: { ...fullEnv, ...config },
          getuid: () => 0,
        }),
      ).toThrow();
      expect(spawnChild).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );
  it("drops root to configured distinct UIDs and GIDs", () => {
    startSupervisor({
      ...options(),
      env: { ...fullEnv, TL_WEB_UID: "10001", TL_WORKER_UID: "10002" },
      getuid: () => 0,
    });
    expect(spawnChild.mock.calls[0][2]).toMatchObject({
      uid: 10001,
      gid: 10001,
    });
    expect(spawnChild.mock.calls[1][2]).toMatchObject({
      uid: 10002,
      gid: 10002,
    });
  });
  it("starts exactly two children and logs names only", () => {
    startSupervisor(options());
    expect(spawnChild).toHaveBeenCalledTimes(2);
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("QLOO_API_KEY");
    for (const value of [
      "qloo-sentinel",
      "llm-sentinel",
      "database-sentinel",
      "session-sentinel",
    ]) {
      expect(output).not.toContain(value);
    }
  });
  it("backs off and exits on the sixth crash across a five-minute window", () => {
    startSupervisor({ ...options(), env: { ...fullEnv, TL_ROLE: "worker" } });
    for (let i = 0; i < 5; i++) {
      children.at(-1).emit("exit", 1);
      vi.advanceTimersByTime(restartDelay(i + 1) - 1);
      expect(spawnChild).toHaveBeenCalledTimes(i + 1);
      vi.advanceTimersByTime(1);
    }
    children.at(-1).emit("exit", 1);
    expect(exit).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(300_000);
    expect(spawnChild).toHaveBeenCalledTimes(6);
    expect(restartDelay(7)).toBe(30_000);
  });
  it("expires old crashes and resets backoff after stable uptime", () => {
    startSupervisor({ ...options(), env: { ...fullEnv, TL_ROLE: "worker" } });
    for (let i = 0; i < 7; i++) {
      vi.advanceTimersByTime(300_001);
      children.at(-1).emit("exit", 1);
      vi.advanceTimersByTime(1_000);
    }
    expect(exit).not.toHaveBeenCalled();
    expect(spawnChild).toHaveBeenCalledTimes(8);
  });
  it("counts a spawn error once even if exit follows", () => {
    startSupervisor({ ...options(), env: { ...fullEnv, TL_ROLE: "worker" } });
    children[0].emit("error", new Error("secret-sentinel"));
    children[0].emit("exit", 1);
    vi.advanceTimersByTime(1_000);
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-sentinel");
  });
  it("handles a synchronous spawn failure", () => {
    startSupervisor({
      ...options(),
      env: { TL_ROLE: "worker" },
      spawnChild: () => {
        throw new Error("secret");
      },
    });
    vi.advanceTimersByTime(31_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it.each(["SIGTERM", "SIGINT"])(
    "forwards %s and waits for both children",
    (signal) => {
      const supervisor = startSupervisor(options());
      supervisor.shutdown(signal);
      expect(signalChild).toHaveBeenCalledTimes(2);
      expect(signalChild).toHaveBeenCalledWith(children[0], signal);
      children[0].emit("exit", 0);
      expect(exit).not.toHaveBeenCalled();
      children[1].emit("exit", 0);
      expect(exit).toHaveBeenCalledWith(0);
      vi.advanceTimersByTime(30_000);
      expect(exit).toHaveBeenCalledTimes(1);
    },
  );
  it("kills remaining process groups after the 25-second grace period", () => {
    const supervisor = startSupervisor(options());
    supervisor.shutdown();
    supervisor.shutdown();
    vi.advanceTimersByTime(24_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(signalChild).toHaveBeenCalledWith(children[0], "SIGKILL");
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("cancels pending restarts on shutdown", () => {
    const supervisor = startSupervisor(options());
    children[1].emit("exit", 0);
    supervisor.shutdown();
    children[0].emit("exit", 0);
    vi.advanceTimersByTime(60_000);
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
