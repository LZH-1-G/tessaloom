import { chmodSync, chownSync, lstatSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startSupervisor } from "../scripts/start.mjs";

// Compose secrets are file mounts, not a managed secret store. Only root loads them.
const secret = (name) => readFileSync(`/run/secrets/${name}`, "utf8").trim();
try {
  // Compose implementations may expose file-backed secrets with permissive modes.
  // Protect their container-local parent before either unprivileged child exists.
  if (process.getuid?.() !== 0 || !lstatSync("/run/secrets").isDirectory())
    throw new Error();
  chownSync("/run/secrets", 0, 0);
  chmodSync("/run/secrets", 0o700);
  const migrating = process.argv[2] === "migrate";
  const role = migrating ? "tessaloom_migrator" : "tessaloom_app";
  const password = secret(migrating ? "migrator_password" : "app_password");
  if (!password || process.env.APP_ENV !== "production") throw new Error();
  const url = new URL(`postgresql://${role}@postgres:5432/tessaloom`);
  url.password = password;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "/run/tessaloom/db-ca.crt");
  if (migrating) {
    // A one-shot service with no runtime/session/provider secrets.
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", "packages/db/dist/migrate.mjs"],
      {
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          APP_ENV: "production",
          DATABASE_URL_MIGRATOR: url.toString(),
        },
      },
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  } else {
    const access = process.env.RUN_ACCESS ?? "off";
    if (!["off", "invite"].includes(access)) throw new Error();
    startSupervisor({
      env: {
        ...process.env,
        DATABASE_URL: url.toString(),
        RUN_ACCESS: access,
        SESSION_SECRET: secret("session_secret"),
        SHARE_TOKEN_PEPPER: secret("share_token_pepper"),
        QLOO_API_KEY: secret("qloo_key") || undefined,
        ANTHROPIC_API_KEY: secret("anthropic_key") || undefined,
      },
    });
  }
} catch {
  console.error(JSON.stringify({ event: "deployment_configuration_invalid" }));
  process.exitCode = 1;
}
