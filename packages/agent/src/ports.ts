import type { z } from "zod";
import type { ValidationIssue } from "./validators";

/**
 * Ports the pure orchestrator uses. They are structural mirrors of the Qloo adapter and the
 * LLM gateway, so `packages/agent` keeps depending on `core` only (ADR-022/ADR-023).
 */

export interface QlooEntityItem {
  qlooId: string;
  name: string;
  type?: string;
  popularity?: number;
  affinity?: number;
  disambiguation?: string;
  description?: string;
  tags?: { tagId: string; name: string; type?: string }[];
  missingFields: string[];
}
export interface QlooTagItem {
  tagId: string;
  name: string;
  tagType?: string;
  popularity?: number;
  affinity?: number;
}

export interface QlooProvenanceLike {
  toolInvocationId: string | null;
  dataOrigin: "LIVE" | "CACHE" | "REPLAY" | "FIXTURE";
  requestHash: string;
  workflow: string;
}

export interface ResolutionCandidatesLike {
  entities: {
    qlooId: string;
    name: string;
    type?: string;
    popularity?: number;
    description?: string;
    disambiguation?: string;
    legacyType: boolean;
    source: "selected" | "alternative" | "issue_candidate" | "search";
    rankInSource: number;
  }[];
  tags: {
    tagId: string;
    name: string;
    tagType?: string;
    popularity?: number;
    rankInSource: number;
  }[];
  harnessSelectedQlooId?: string;
  provenance: Record<string, unknown>[];
}

export type QlooResult<T> =
  | {
      kind: "OK";
      items: T[];
      quality: "FULL" | "PARTIAL" | "DEGRADED";
      resolution?: ResolutionCandidatesLike;
      provenance: QlooProvenanceLike;
      raw: unknown;
    }
  | { kind: "EMPTY"; provenance: QlooProvenanceLike; raw: unknown }
  | {
      kind: "NEEDS_INPUT";
      resolution: ResolutionCandidatesLike;
      provenance: QlooProvenanceLike;
      raw: unknown;
    }
  | { kind: "UNSUPPORTED"; reason: string }
  | {
      kind: "ERROR";
      code: string;
      retryable: boolean;
      provenance: QlooProvenanceLike | null;
    };

export interface QlooCallContext {
  projectId: string;
  runId: string;
  stepSeq: number;
  purpose: string;
  signal?: AbortSignal;
}

type InsightType =
  | "artist"
  | "book"
  | "brand"
  | "movie"
  | "person"
  | "place"
  | "podcast"
  | "tv_show"
  | "videogame";

export interface QlooPort {
  /** `qloo api search` (V1: the only plain search; raw results carry `tags[]`). */
  searchEntities(
    input: { query: string; type?: InsightType | "locality"; take?: number },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooEntityItem>>;
  findTags(
    input: { query: string; limit?: number },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooTagItem>>;
  describeEntity(
    input: { entity: string; type?: InsightType | "locality" },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooEntityItem>>;
  recommend(
    input: {
      targetType: InsightType;
      signals?: string[];
      signalTags?: string[];
      includeTags?: string[];
      limit?: number;
    },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooEntityItem>>;
  rank(
    input: { options: string[]; optionType: InsightType; signals?: string[] },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooEntityItem>>;
  entityTags(
    input: { entities: string[]; limit?: number },
    ctx: QlooCallContext,
  ): Promise<QlooResult<QlooTagItem>>;
  compareAudiences(
    input: { groupA: string[]; groupB: string[] },
    ctx: QlooCallContext,
  ): Promise<
    QlooResult<{
      shared: { tagId: string; subtype?: string }[];
      a: { tagId: string; subtype?: string }[];
      b: { tagId: string; subtype?: string }[];
      matchEntities: unknown[];
    }>
  >;
  wherePopular(
    input: { entity: string; within: string },
    ctx: QlooCallContext,
  ): Promise<
    QlooResult<{ latitude: number; longitude: number; affinity?: number }>
  >;
  trends(
    input: {
      entities: string[];
      entityType: InsightType;
      startDate: string;
      endDate: string;
    },
    ctx: QlooCallContext,
  ): Promise<
    QlooResult<{
      entityId?: string;
      points: {
        date: string;
        rankVelocity?: number;
        velocityFoldChange?: number;
      }[];
    }>
  >;
  audienceDemographics(
    input: { entity: string },
    ctx: QlooCallContext,
  ): Promise<
    QlooResult<{ dimension: "age" | "gender"; band: string; index: number }>
  >;
}

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export type LlmResult<T> = {
  usageComplete?: boolean;
  invocationIds: string[];
  modelId: string | null;
  fallbackUsed: boolean;
  usage: LlmUsage;
  costUsd: number;
  attempts: number;
} & (
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "REFUSED"
        | "TRUNCATED"
        | "INVALID_OUTPUT"
        | "UNAVAILABLE"
        | "BUDGET"
        | "CANCELLED"
        | "CONFIGURATION";
      issues?: ValidationIssue[];
      salvage?: T;
      /** UNAVAILABLE only: false = possibly billed, so the step must not be retried. */
      retryable?: boolean;
    }
);

export interface LlmPort {
  generate<S extends z.ZodType>(req: {
    role: "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
    promptId: string;
    input: unknown;
    inputExcerpt?: Record<string, unknown>;
    schema: S;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    maxOutputTokens: number;
    validate?: (value: z.output<S>) => ValidationIssue[];
    ctx: {
      inputOrigin?: "synthetic" | "unknown";
      projectId: string;
      runId?: string | null;
      signal?: AbortSignal;
      remainingUsd?: number;
      remainingCalls?: number;
      remainingOutputTokens?: number;
    };
  }): Promise<LlmResult<z.output<S>>>;
}
