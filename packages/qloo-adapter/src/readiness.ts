import { execFile } from "node:child_process";

export interface QlooReadiness {
  ready: boolean;
  harnessVersion: string | null;
  credentialConfigured: boolean;
  endpointTrusted: boolean;
  endpoint: string | null;
  reason?: string;
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
      { env, timeout: timeoutMs, shell: false, windowsHide: true },
      (error, stdout) => {
        // `qloo doctor` exits non-zero on warnings (e.g. no model provider); stdout is still valid.
        const text = String(stdout ?? "").trim();
        if (text) resolve(text);
        else reject(error ?? new Error("no output"));
      },
    );
  });
}

/**
 * Local readiness without contacting Qloo (V1): `qloo --version` and `qloo doctor --json`
 * (no --network). Ready only when the credential is configured and the configured endpoint
 * is the expected one and trusted. Messages are parsed for state only, never logged.
 */
export async function checkQlooReadiness(options: {
  expectedBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}): Promise<QlooReadiness> {
  const env = options.env ?? process.env;
  const command = options.command ?? "qloo";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const expected = options.expectedBaseUrl.replace(/\/+$/, "");
  try {
    const version =
      (await run(command, ["--version"], env, timeoutMs)).split(/\s+/)[0] ??
      null;
    const doctor = JSON.parse(
      await run(command, ["doctor", "--json"], env, timeoutMs),
    ) as {
      checks?: { id?: string; status?: string; message?: string }[];
    };
    const check = (id: string) => doctor.checks?.find((c) => c.id === id);
    const auth = check("qloo-auth");
    const trust = check("qloo-endpoint-trust");
    const credentialConfigured = auth?.status === "ok";
    const trustMessage = trust?.message ?? "";
    const endpointTrusted =
      trust?.status === "ok" &&
      /trusted|official/i.test(trustMessage) &&
      !/not trusted/i.test(trustMessage) &&
      trustMessage.includes(expected);
    const ready = credentialConfigured && endpointTrusted;
    return {
      ready,
      harnessVersion: version,
      credentialConfigured,
      endpointTrusted,
      endpoint: endpointTrusted ? expected : null,
      reason: ready
        ? undefined
        : !credentialConfigured
          ? "credential_missing"
          : "endpoint_not_trusted",
    };
  } catch {
    return {
      ready: false,
      harnessVersion: null,
      credentialConfigured: false,
      endpointTrusted: false,
      endpoint: null,
      reason: "harness_unavailable",
    };
  }
}
