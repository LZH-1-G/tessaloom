import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { qlooChildEnv } from "./env";
import {
  TransportError,
  type HarnessCall,
  type HarnessTransport,
  type RawHarnessResult,
} from "../types";

export interface McpTransportOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  maxRestartsPerMinute?: number;
}

/**
 * Persistent `qloo mcp` stdio child (the kit's primary route). The child receives the
 * worker's Qloo-only environment (model keys and database credentials are excluded).
 * After repeated failures within a minute it reports MCP_UNAVAILABLE so the router can use
 * the CLI transport; it never falls back to fixtures.
 */
export class McpTransport implements HarnessTransport {
  readonly name = "HARNESS_MCP" as const;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private restarts: number[] = [];

  constructor(private readonly options: McpTransportOptions = {}) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < 60_000);
    if (this.restarts.length >= (this.options.maxRestartsPerMinute ?? 3)) {
      throw new TransportError(
        "MCP_UNAVAILABLE",
        "qloo mcp restarted too often",
        true,
      );
    }
    this.restarts.push(now);
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command ?? "qloo",
        args: ["mcp"],
        env: qlooChildEnv(this.options.env ?? process.env),
        stderr: "ignore",
      });
      const client = new Client({ name: "tessaloom-worker", version: "0.1.0" });
      transport.onclose = () => {
        this.client = null;
      };
      try {
        await client.connect(transport);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new TransportError(
          code === "ENOENT" ? "HARNESS_NOT_FOUND" : "MCP_UNAVAILABLE",
          "Could not start qloo mcp",
          code !== "ENOENT",
        );
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async call(
    call: HarnessCall,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<RawHarnessResult> {
    if (call.kind !== "workflow") {
      throw new TransportError(
        "MCP_UNAVAILABLE",
        "Search is not an MCP workflow",
        false,
      );
    }
    const client = await this.connect();
    const started = Date.now();
    try {
      const result = await client.callTool(
        { name: `qloo_${call.workflow}`, arguments: call.args },
        undefined,
        { signal, timeout: timeoutMs },
      );
      let payload: unknown = result.structuredContent;
      if (payload === undefined && Array.isArray(result.content)) {
        const text = result.content.find((part) => part.type === "text");
        if (text && "text" in text) {
          try {
            payload = JSON.parse(String(text.text));
          } catch {
            throw new TransportError(
              "INVALID_JSON",
              "MCP result was not JSON",
              false,
            );
          }
        }
      }
      return {
        payload,
        exitCode: null,
        durationMs: Date.now() - started,
        transport: this.name,
      };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (signal?.aborted)
        throw new TransportError("ABORTED", "Harness call aborted", false);
      const message = error instanceof Error ? error.message : "";
      if (/timed out|timeout/i.test(message))
        throw new TransportError("TIMEOUT", "MCP call timed out", true);
      this.client = null;
      throw new TransportError("MCP_UNAVAILABLE", "MCP call failed", true);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }
}
