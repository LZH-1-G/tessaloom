import { execFile } from "node:child_process";
import { qlooChildEnv } from "./transports/env";

export interface QlooReadiness {
  ready: boolean;
  harnessVersion: string | null;
  credentialConfigured: boolean;
  endpointTrusted: boolean;
  endpoint: string | null;
  reason?: string;
  probeDurationMs: number;
  probeFailure?:
    | "not_found"
    | "permission_denied"
    | "timeout"
    | "output_limit"
    | "process_failed"
    | "invalid_report";
}

class ProbeError extends Error {
  constructor(readonly failure: NonNullable<QlooReadiness["probeFailure"]>) {
    super("Local Harness probe failed");
  }
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
        shell: false,
        windowsHide: true,
      },
      (error, stdout) => {
        // Doctor exits 1 for warnings (e.g. no model provider). Never accept output
        // from a timed-out, signalled, truncated or otherwise failed process.
        if (error) {
          const failure =
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "output_limit"
              : error.killed
                ? "timeout"
                : error.code === "ENOENT"
                  ? "not_found"
                  : error.code === "EACCES" || error.code === "EPERM"
                    ? "permission_denied"
                    : error.code !== 1 || error.signal
                      ? "process_failed"
                      : null;
          if (failure) return reject(new ProbeError(failure));
        }
        const text = String(stdout ?? "").trim();
        if (text) resolve(text);
        else reject(new ProbeError("invalid_report"));
      },
    );
  });
}

/**
 * Local readiness without contacting Qloo (V1): one `qloo doctor --json`
 * (no --network). Ready only when the credential is configured and the configured endpoint
 * is the expected one and trusted. Doctor already includes the Harness version, avoiding
 * two expensive CLI cold starts on the shared 0.2 CPU runtime. Messages are never logged.
 */
export async function checkQlooReadiness(options: {
  expectedBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}): Promise<QlooReadiness> {
  const env = qlooChildEnv(options.env ?? process.env);
  const command = options.command ?? "qloo";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = Date.now();
  try {
    const doctor = JSON.parse(
      await run(command, ["doctor", "--json"], env, timeoutMs),
    ) as {
      versions?: { harness?: string };
      checks?: { id?: string; status?: string; message?: string }[];
    };
    const version = doctor?.versions?.harness;
    if (
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
      version.length > 64 ||
      !Array.isArray(doctor.checks)
    )
      throw new ProbeError("invalid_report");
    const check = (id: string) => doctor.checks?.find((c) => c?.id === id);
    const auth = check("qloo-auth");
    const trust = check("qloo-endpoint-trust");
    if (!auth || !trust || typeof trust.message !== "string")
      throw new ProbeError("invalid_report");
    const credentialConfigured = auth?.status === "ok";
    // The pinned CLI reports a URL in this fixed template. Compare normalized full
    // URLs, never substrings (which could accept a different host with this prefix).
    const reported =
      /^Qloo API endpoint is (?:official|explicitly trusted via [^\r\n]+): (https:\/\/\S+)$/.exec(
        trust.message,
      )?.[1];
    const normalize = (value: string | undefined) => {
      try {
        const url = new URL(value ?? "");
        return url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
          ? url.href.replace(/\/+$/, "")
          : null;
      } catch {
        return null;
      }
    };
    const expected = normalize(options.expectedBaseUrl);
    const endpointTrusted =
      trust?.status === "ok" &&
      expected !== null &&
      normalize(reported) === expected;
    const ready = credentialConfigured && endpointTrusted;
    return {
      ready,
      harnessVersion: version,
      credentialConfigured,
      endpointTrusted,
      endpoint: endpointTrusted ? expected : null,
      probeDurationMs: Date.now() - started,
      reason: ready
        ? undefined
        : !credentialConfigured
          ? "credential_missing"
          : "endpoint_not_trusted",
    };
  } catch (error) {
    return {
      ready: false,
      harnessVersion: null,
      credentialConfigured: false,
      endpointTrusted: false,
      endpoint: null,
      reason: "harness_unavailable",
      probeDurationMs: Date.now() - started,
      probeFailure:
        error instanceof ProbeError ? error.failure : "invalid_report",
    };
  }
}
