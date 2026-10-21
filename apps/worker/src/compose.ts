import type { LlmPort, Ports, QlooPort } from "@tessaloom/agent";
import { RunConfig } from "@tessaloom/core";
import type { Db } from "@tessaloom/db";
import type { LlmGateway } from "@tessaloom/llm-gateway";
import {
  FixtureTransport,
  QlooAdapter,
  SyntheticFixtureTransport,
  createDbQuotaGuard,
  createDbRecorder,
  createLiveTransport,
  type HarnessTransport,
} from "@tessaloom/qloo-adapter";

export const QLOO_ADAPTER_VERSION = "qloo-adapter-0.2.0";
export const EVALUATION_RULESET_VERSION = "ruleset-2026.10-m4";

/** AGENT_WORKFLOW §2 starting efforts. */
export const EFFORT_BY_ROLE = {
  R1: "low",
  R2: "low",
  R3: "high",
  R4: "high",
  R5: "medium",
  R6: "medium",
} as const;

/** The runtime configuration every new run is stamped with (published via the heartbeat). */
export function buildRunConfig(input: {
  llmModel: string;
  llmFallbackModel: string;
  promptVersions: Record<string, string>;
  harnessVersion: string | null;
}): RunConfig {
  return RunConfig.parse({
    llmModel: input.llmModel,
    llmFallbackModel: input.llmFallbackModel,
    effortByRole: EFFORT_BY_ROLE,
    promptVersions: input.promptVersions,
    qlooAdapterVersion: QLOO_ADAPTER_VERSION,
    harnessVersion: input.harnessVersion ?? "unavailable",
    evaluationRulesetVersion: EVALUATION_RULESET_VERSION,
  });
}

/** Port used when Qloo is not configured: every call fails closed (never a fixture fallback). */
const unconfigured = async () =>
  ({
    kind: "ERROR",
    code: "QLOO_NOT_CONFIGURED",
    retryable: false,
    provenance: null,
  }) as const;
export const UNCONFIGURED_QLOO: QlooPort = {
  searchEntities: unconfigured,
  findTags: unconfigured,
  describeEntity: unconfigured,
  recommend: unconfigured,
  rank: unconfigured,
  entityTags: unconfigured,
  compareAudiences: unconfigured,
  wherePopular: unconfigured,
  trends: unconfigured,
  audienceDemographics: unconfigured,
};

export function createQlooAdapter(
  db: Db,
  input: {
    mode: "live" | "fixture" | "synthetic" | undefined;
    appEnv: string;
    harnessVersion: string | null;
    dailyLimit: number;
    rateLimitPerMin: number;
    fixtureRoot?: string;
    transport?: HarnessTransport;
    env?: NodeJS.ProcessEnv;
  },
): QlooAdapter | null {
  let transport = input.transport;
  if (!transport) {
    if (input.mode === "live")
      transport = createLiveTransport({ env: input.env });
    else if (input.mode === "fixture")
      transport = new FixtureTransport(
        input.fixtureRoot ?? "fixtures/qloo",
        input.appEnv,
      );
    else if (input.mode === "synthetic")
      transport = new SyntheticFixtureTransport(input.appEnv);
    else return null;
  }
  return new QlooAdapter({
    transport,
    harnessVersion: input.harnessVersion ?? "fixture",
    recorder: createDbRecorder(db),
    quota: createDbQuotaGuard(db, { dailyLimit: input.dailyLimit }),
    // The limiter protects the shared Qloo quota; fixtures generate no Qloo traffic.
    rateLimitPerMin:
      transport.name === "FIXTURE" ? 100_000 : input.rateLimitPerMin,
  });
}

/** The adapter and the gateway satisfy the agent's ports structurally (no casts). */
export function buildPorts(
  qloo: QlooAdapter | null,
  llm: LlmGateway | null,
): Ports {
  const qlooPort: QlooPort = qloo ?? UNCONFIGURED_QLOO;
  const llmPort: LlmPort | null = llm;
  return { qloo: qlooPort, llm: llmPort };
}
