import { execFile } from "node:child_process";
import { SearchEntitiesInput } from "../inputs";
import { qlooChildEnv } from "./env";
import {
  TransportError,
  WORKFLOWS,
  type HarnessCall,
  type HarnessTransport,
  type RawHarnessResult,
} from "../types";

export interface CliTransportOptions {
  command?: string; // default "qloo" resolved via the (supervisor-controlled) PATH
  env?: NodeJS.ProcessEnv;
  maxBufferBytes?: number;
}

/** Build argv for an allowlisted harness command. Never includes credentials (`--api-key`). */
export function buildCliArgs(call: HarnessCall): string[] {
  if (call.kind === "search") {
    const args = SearchEntitiesInput.parse(call.args);
    return [
      "api",
      "search",
      "--query",
      args.query,
      ...(args.type ? ["--type", args.type] : []),
      "--take",
      String(args.take),
      "--json",
    ];
  }
  if (!(WORKFLOWS as readonly string[]).includes(call.workflow)) {
    throw new TransportError(
      "PROCESS_FAILED",
      "Workflow is not allowlisted",
      false,
    );
  }
  return ["exec", call.workflow, "--input", JSON.stringify(call.args)];
}

/**
 * `qloo exec` / `qloo api search` over execFile (no shell). V1: failures print a JSON error
 * object on stdout and exit non-zero (1 = QLOO_CONTRACT, 4 = QLOO_AUTH), so stdout is parsed
 * regardless of the exit code. stdout/stderr content is never logged.
 */
export class CliTransport implements HarnessTransport {
  readonly name = "HARNESS_CLI" as const;
  constructor(private readonly options: CliTransportOptions = {}) {}

  call(
    call: HarnessCall,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<RawHarnessResult> {
    const argv = buildCliArgs(call);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      execFile(
        this.options.command ?? "qloo",
        argv,
        {
          env: qlooChildEnv(this.options.env ?? process.env),
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: this.options.maxBufferBytes ?? 8 * 1024 * 1024,
          signal,
          shell: false,
          windowsHide: true,
        },
        (error, stdout) => {
          const durationMs = Date.now() - started;
          const failure = error as
            | (NodeJS.ErrnoException & {
                killed?: boolean;
                code?: string | number;
              })
            | null;
          if (failure?.name === "AbortError") {
            return reject(
              new TransportError("ABORTED", "Harness call aborted", false),
            );
          }
          if (failure?.code === "ENOENT") {
            return reject(
              new TransportError(
                "HARNESS_NOT_FOUND",
                "qloo executable not found on PATH",
                false,
              ),
            );
          }
          if (failure?.killed) {
            return reject(
              new TransportError("TIMEOUT", "Harness call timed out", true),
            );
          }
          const text = String(stdout ?? "").trim();
          if (!text) {
            return reject(
              new TransportError(
                "PROCESS_FAILED",
                "Harness produced no output",
                false,
              ),
            );
          }
          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            return reject(
              new TransportError(
                "INVALID_JSON",
                "Harness output was not JSON",
                false,
              ),
            );
          }
          const exitCode = failure
            ? typeof failure.code === "number"
              ? failure.code
              : 1
            : 0;
          resolve({ payload, exitCode, durationMs, transport: this.name });
        },
      );
    });
  }
}
