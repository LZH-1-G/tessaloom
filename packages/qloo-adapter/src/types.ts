import type {
  DataOrigin,
  EnvelopeSummary,
  QlooTransport,
  ResolutionCandidates,
} from "@tessaloom/core";

/** The nine canonical harness workflows (V1: `qloo exec` operations / `qloo_*` MCP tools). */
export const WORKFLOWS = [
  "recommend",
  "rank",
  "describe",
  "where_popular",
  "compare_audiences",
  "entity_tags",
  "audience_demographics",
  "trends",
  "find_tags",
] as const;
export type Workflow = (typeof WORKFLOWS)[number];

/** One harness invocation. Search has no workflow and uses `qloo api search` (V1). */
export type HarnessCall =
  | { kind: "workflow"; workflow: Workflow; args: Record<string, unknown> }
  | { kind: "search"; args: { query: string; type?: string; take: number } };

/** What a transport observed. Parsing into an outcome happens in envelope.ts. */
export interface RawHarnessResult {
  payload: unknown; // parsed JSON (envelope, error object, or search array)
  exitCode: number | null;
  durationMs: number;
  transport: QlooTransport; // the transport that actually served the call
}

export class TransportError extends Error {
  constructor(
    readonly code:
      | "HARNESS_NOT_FOUND"
      | "TIMEOUT"
      | "ABORTED"
      | "INVALID_JSON"
      | "PROCESS_FAILED"
      | "MCP_UNAVAILABLE"
      | "FIXTURE_MISSING",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface HarnessTransport {
  readonly name: QlooTransport;
  call(
    call: HarnessCall,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<RawHarnessResult>;
  close?(): Promise<void>;
}

/** Harness-reported provenance plus Tessaloom's invocation identity. */
export interface QlooProvenance {
  toolInvocationId: string | null;
  snapshotId: string | null;
  transport: QlooTransport;
  workflow: string;
  harnessVersion: string;
  requestHash: string;
  dataOrigin: DataOrigin;
  retrievedAt: string;
  correlationId?: string;
  endpoint?: string;
  requests: { method: "GET"; path: string; query: Record<string, unknown> }[];
}

export interface NormalizedEntity {
  qlooId: string;
  name: string;
  type?: string; // category URN (recommend/rank read it from `subtype`)
  legacyType: boolean;
  popularity?: number;
  affinity?: number; // aggregate audience affinity, never creative fit
  disambiguation?: string;
  description?: string;
  tags?: { tagId: string; name: string; type?: string }[];
  explainability?: unknown;
  properties?: Record<string, unknown>;
  missingFields: string[];
}

export interface NormalizedTag {
  tagId: string;
  name: string;
  tagType?: string;
  popularity?: number;
  affinity?: number;
}

/** compare_audiences: tag profiles per group plus the overlap lists Qloo returned. No score. */
export interface AudienceComparison {
  shared: ComparisonTag[];
  a: ComparisonTag[];
  b: ComparisonTag[];
  matchEntities: unknown[];
}
export interface ComparisonTag {
  tagId: string;
  name: string;
  subtype?: string;
  entityId?: string;
  popularity?: number;
  count?: number;
}

export interface GeoPopularity {
  latitude: number;
  longitude: number;
  geohash?: string;
  affinity?: number;
  affinityRank?: number;
  popularity?: number;
}

export interface DemographicFact {
  entityId?: string;
  dimension: "age" | "gender";
  band: string;
  index: number; // relative index in [-1, 1], not a share of people
}

export interface TrendSeries {
  entityId?: string;
  name?: string;
  points: TrendPoint[];
}
export interface TrendPoint {
  date: string;
  populationPercentile?: number;
  populationRank?: number;
  populationRankRaw?: string;
  rankVelocity?: number;
  velocityFoldChange?: number;
  percentDelta?: number;
}

export type Quality = "FULL" | "PARTIAL" | "DEGRADED";

/**
 * Typed outcome of one adapter call. `raw` is held in memory only, so evaluators can extract
 * and verify facts before it is discarded (raw retention is off by default; R-08).
 */
export type QlooOutcome<T> =
  | {
      kind: "OK";
      items: T[];
      quality: Quality;
      summary?: string;
      resolution?: ResolutionCandidates;
      envelope: EnvelopeSummary;
      provenance: QlooProvenance;
      raw: unknown;
    }
  | {
      kind: "EMPTY";
      summary?: string;
      envelope: EnvelopeSummary;
      provenance: QlooProvenance;
      raw: unknown;
    }
  | {
      kind: "NEEDS_INPUT";
      summary?: string;
      resolution: ResolutionCandidates;
      envelope: EnvelopeSummary;
      provenance: QlooProvenance;
      raw: unknown;
    }
  // A capability/type combination known to be rejected upstream (V1); no Qloo call is made.
  | { kind: "UNSUPPORTED"; reason: string; evidence: string }
  | {
      kind: "ERROR";
      code: string;
      retryable: boolean;
      recovery?: string;
      envelope: EnvelopeSummary;
      provenance: QlooProvenance | null;
    };

export type CachePolicy = "prefer-cache" | "live-only";

export interface CallContext {
  projectId: string;
  runId?: string | null;
  stepSeq?: number | null;
  purpose: string;
  signal?: AbortSignal;
  cachePolicy?: CachePolicy;
}
