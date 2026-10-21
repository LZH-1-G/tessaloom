import { spawn } from "node:child_process";
import { buildChildEnv, validateSupervisorEnv } from "./start.mjs";

validateSupervisorEnv(process.env);
const child = spawn("pnpm", ["--filter", "web", "dev"], {
  stdio: "inherit",
  env: { ...buildChildEnv("web", process.env), PATH: process.env.PATH },
});
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"]))
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
