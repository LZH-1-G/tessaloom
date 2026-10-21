import { parseWorkerEnv } from "@tessaloom/config/env";

try {
  parseWorkerEnv(process.env);
} catch (error) {
  console.error(
    JSON.stringify({
      event: "worker_config_invalid",
      message: (error as Error).message,
    }),
  );
  process.exit(1);
}

// A lifecycle-only host in M0: no jobs, database schema, harness process, or provider calls.
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;

function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  console.log(JSON.stringify({ event: "worker_stopped", signal }));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log(
  JSON.stringify({
    event: "worker_started",
    milestone: "M0",
    pid: process.pid,
  }),
);
