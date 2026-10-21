import { CliTransport } from "./cli";
import { McpTransport } from "./mcp";
import {
  TransportError,
  type HarnessCall,
  type HarnessTransport,
  type RawHarnessResult,
} from "../types";

/**
 * Live harness routing (ADR-019): workflows use MCP (primary) and fall back to the CLI when
 * MCP is unavailable; search always uses `qloo api search` (no search workflow exists).
 * Both are official live harness surfaces. This module cannot construct fixtures.
 */
export class LiveHarnessRouter implements HarnessTransport {
  readonly name = "HARNESS_MCP" as const;

  constructor(
    private readonly primary: HarnessTransport | null,
    private readonly cli: HarnessTransport,
  ) {}

  async call(
    call: HarnessCall,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<RawHarnessResult> {
    if (call.kind === "search" || !this.primary)
      return this.cli.call(call, options);
    try {
      return await this.primary.call(call, options);
    } catch (error) {
      if (
        error instanceof TransportError &&
        (error.code === "MCP_UNAVAILABLE" || error.code === "HARNESS_NOT_FOUND")
      ) {
        return this.cli.call(call, options);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.primary?.close?.();
  }
}

export function createLiveTransport(
  options: { env?: NodeJS.ProcessEnv; useMcp?: boolean } = {},
): LiveHarnessRouter {
  const cli = new CliTransport({ env: options.env });
  const mcp =
    options.useMcp === false ? null : new McpTransport({ env: options.env });
  return new LiveHarnessRouter(mcp, cli);
}
