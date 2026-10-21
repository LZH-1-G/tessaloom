import { readFile } from "node:fs/promises";
import path from "node:path";
import { requestHash } from "@tessaloom/core";
import {
  TransportError,
  type HarnessCall,
  type HarnessTransport,
  type RawHarnessResult,
} from "../types";

export const FIXTURE_LABEL = "DEVELOPMENT FIXTURE — NOT QLOO DATA";

/** Fixture identity is independent of the harness version, so fixtures stay stable. */
export function fixtureHash(call: HarnessCall): string {
  return requestHash({
    workflow: call.kind === "search" ? "search" : call.workflow,
    args: call.args,
    harnessVersion: "fixture",
  });
}

export function fixturePath(root: string, call: HarnessCall): string {
  return path.join(
    root,
    call.kind === "search" ? "search" : call.workflow,
    `${fixtureHash(call)}.json`,
  );
}

/**
 * Synthetic, labeled fixtures for development, CI, and E2E (ADR-014). Refuses to exist in
 * production, refuses files without the synthetic label, and never returns "closest" data.
 */
export class FixtureTransport implements HarnessTransport {
  readonly name = "FIXTURE" as const;

  constructor(
    private readonly root: string,
    appEnv: string,
  ) {
    if (appEnv === "production") {
      throw new Error("FixtureTransport cannot be constructed in production");
    }
  }

  async call(call: HarnessCall): Promise<RawHarnessResult> {
    let text: string;
    try {
      text = await readFile(fixturePath(this.root, call), "utf8");
    } catch {
      throw new TransportError(
        "FIXTURE_MISSING",
        "No fixture for this exact request",
        false,
      );
    }
    const file = JSON.parse(text) as {
      _fixture?: { synthetic?: unknown; label?: unknown };
      payload?: unknown;
      exitCode?: number;
    };
    if (
      file._fixture?.synthetic !== true ||
      file._fixture.label !== FIXTURE_LABEL
    ) {
      throw new TransportError(
        "FIXTURE_MISSING",
        "Fixture file is not labeled synthetic",
        false,
      );
    }
    return {
      payload: file.payload,
      exitCode: file.exitCode ?? 0,
      durationMs: 0,
      transport: this.name,
    };
  }
}
