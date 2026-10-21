import type { EnvelopeSummary, QlooTransport } from "@tessaloom/core";
import { requestHash } from "@tessaloom/core";
import type { z } from "zod";
import { parseEnvelope, type ParsedEnvelope } from "./envelope";
import {
  AudienceDemographicsInput,
  CompareAudiencesInput,
  DescribeEntityInput,
  EntityTagsInput,
  FindTagsInput,
  KNOWN_UNSUPPORTED,
  RankInput,
  RecommendInput,
  SearchEntitiesInput,
  TrendsInput,
  WherePopularInput,
  toHarness,
} from "./inputs";
import { Semaphore, TokenBucket, TtlCache } from "./limits";
import {
  normalizeComparison,
  normalizeDemographics,
  normalizeDescribe,
  normalizeGeo,
  normalizeRanked,
  normalizeSearch,
  normalizeTags,
  normalizeTrends,
} from "./normalize";
import {
  TransportError,
  type AudienceComparison,
  type CallContext,
  type DemographicFact,
  type GeoPopularity,
  type HarnessCall,
  type HarnessTransport,
  type NormalizedEntity,
  type NormalizedTag,
  type QlooOutcome,
  type QlooProvenance,
  type RawHarnessResult,
  type TrendSeries,
} from "./types";

/** Persists one invocation (and its structural snapshot); returns the row identities. */
export interface InvocationRecorder {
  record(input: {
    ctx: CallContext;
    method: string;
    workflow: string;
    transport: QlooTransport;
    args: Record<string, unknown>;
    requestHash: string;
    harnessVersion: string;
    dataOrigin: "LIVE" | "CACHE" | "FIXTURE";
    cacheSourceInvocationId?: string | null;
    envelope: EnvelopeSummary;
    parsed?: ParsedEnvelope;
    raw?: unknown;
    attempt: number;
    latencyMs: number | null;
    retrievedAt: Date;
    ttlMs: number;
  }): Promise<{ toolInvocationId: string; snapshotId: string | null }>;
}

/** Atomically reserves one Qloo call against the daily guard; false means refused. */
export interface QuotaGuard {
  consume(ctx: CallContext): Promise<boolean>;
}

export interface AdapterOptions {
  transport: HarnessTransport;
  harnessVersion: string;
  recorder?: InvocationRecorder;
  quota?: QuotaGuard;
  rateLimitPerMin?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// API_CONTRACTS §6.5: identity data is stable for days; affinity data for one day.
const TTL_MS: Record<string, number> = {
  search: 7 * 86_400_000,
  describe: 7 * 86_400_000,
  find_tags: 7 * 86_400_000,
};
const DEFAULT_TTL_MS = 86_400_000;

type Normalized<T> = { items: T[] };

/** The only gateway to Qloo (ARCHITECTURE §7). Every call is validated, budgeted, and recorded. */
export class QlooAdapter {
  private readonly bucket: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly cache: TtlCache<{
    outcome: QlooOutcome<unknown>;
    toolInvocationId: string | null;
  }>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: AdapterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.bucket = new TokenBucket(
      options.rateLimitPerMin ?? 20,
      this.now,
      this.sleep,
    );
    this.semaphore = new Semaphore(options.concurrency ?? 2);
    this.cache = new TtlCache(500, this.now);
  }

  searchEntities(input: z.input<typeof SearchEntitiesInput>, ctx: CallContext) {
    const call = toHarness.searchEntities(SearchEntitiesInput.parse(input));
    return this.execute<NormalizedEntity>("searchEntities", call, ctx, (p) => ({
      items: normalizeSearch(p),
    }));
  }

  describeEntity(input: z.input<typeof DescribeEntityInput>, ctx: CallContext) {
    const call = toHarness.describeEntity(DescribeEntityInput.parse(input));
    return this.execute<NormalizedEntity>(
      "describeEntity",
      call,
      ctx,
      (p, parsed) => {
        const selected = parsed.resolution?.entities.find(
          (c) => c.source === "selected",
        );
        return { items: normalizeDescribe(p, selected?.type) };
      },
    );
  }

  findTags(input: z.input<typeof FindTagsInput>, ctx: CallContext) {
    const call = toHarness.findTags(FindTagsInput.parse(input));
    return this.execute<NormalizedTag>("findTags", call, ctx, (p) => ({
      items: normalizeTags(p),
    }));
  }

  entityTags(input: z.input<typeof EntityTagsInput>, ctx: CallContext) {
    const call = toHarness.entityTags(EntityTagsInput.parse(input));
    return this.execute<NormalizedTag>("entityTags", call, ctx, (p) => ({
      items: normalizeTags(p),
    }));
  }

  recommend(input: z.input<typeof RecommendInput>, ctx: CallContext) {
    const call = toHarness.recommend(RecommendInput.parse(input));
    return this.execute<NormalizedEntity>("recommend", call, ctx, (p) => ({
      items: normalizeRanked(p),
    }));
  }

  rank(input: z.input<typeof RankInput>, ctx: CallContext) {
    const call = toHarness.rank(RankInput.parse(input));
    return this.execute<NormalizedEntity>("rank", call, ctx, (p) => ({
      items: normalizeRanked(p),
    }));
  }

  compareAudiences(
    input: z.input<typeof CompareAudiencesInput>,
    ctx: CallContext,
  ) {
    const call = toHarness.compareAudiences(CompareAudiencesInput.parse(input));
    return this.execute<AudienceComparison>(
      "compareAudiences",
      call,
      ctx,
      (p) => ({ items: [normalizeComparison(p)] }),
    );
  }

  audienceDemographics(
    input: z.input<typeof AudienceDemographicsInput>,
    ctx: CallContext,
  ) {
    const call = toHarness.audienceDemographics(
      AudienceDemographicsInput.parse(input),
    );
    return this.execute<DemographicFact>(
      "audienceDemographics",
      call,
      ctx,
      (p) => ({ items: normalizeDemographics(p) }),
    );
  }

  wherePopular(input: z.input<typeof WherePopularInput>, ctx: CallContext) {
    const call = toHarness.wherePopular(WherePopularInput.parse(input));
    return this.execute<GeoPopularity>("wherePopular", call, ctx, (p) => ({
      items: normalizeGeo(p),
    }));
  }

  trends(input: z.input<typeof TrendsInput>, ctx: CallContext) {
    const call = toHarness.trends(TrendsInput.parse(input));
    return this.execute<TrendSeries>("trends", call, ctx, (p) => ({
      items: normalizeTrends(p),
    }));
  }

  async close(): Promise<void> {
    await this.options.transport.close?.();
  }

  private workflowName(call: HarnessCall): string {
    return call.kind === "search" ? "search" : call.workflow;
  }

  private backoff(attempt: number, code: string): number {
    const base = /RATE/i.test(code) ? [5_000, 15_000] : [1_000, 3_000];
    const delay = base[Math.min(attempt - 1, base.length - 1)] ?? 3_000;
    return Math.round(delay * (0.7 + this.random() * 0.6));
  }

  private async execute<T>(
    method: string,
    call: HarnessCall,
    ctx: CallContext,
    normalize: (payload: unknown, parsed: ParsedEnvelope) => Normalized<T>,
  ): Promise<QlooOutcome<T>> {
    const workflow = this.workflowName(call);
    const unsupported = KNOWN_UNSUPPORTED.find(
      (u) => u.workflow === workflow && u.when(call.args),
    );
    if (unsupported)
      return {
        kind: "UNSUPPORTED",
        reason: unsupported.reason,
        evidence: unsupported.evidence,
      };

    const { harnessVersion, transport, quota } = this.options;
    const hash = requestHash({ workflow, args: call.args, harnessVersion });
    const ttlMs = TTL_MS[workflow] ?? DEFAULT_TTL_MS;

    // Fixture data is never cached: a cache hit would be recorded as CACHE and could lose its
    // FIXTURE origin (the fixture firewall, ADR-014). Fixtures cost nothing to re-read.
    const cacheable = transport.name !== "FIXTURE";
    if (cacheable && (ctx.cachePolicy ?? "prefer-cache") === "prefer-cache") {
      const hit = this.cache.get(hash);
      if (
        hit &&
        hit.outcome.kind !== "UNSUPPORTED" &&
        hit.outcome.kind !== "ERROR"
      ) {
        return this.fromCache(
          hit as {
            outcome: Exclude<QlooOutcome<T>, { kind: "UNSUPPORTED" | "ERROR" }>;
            toolInvocationId: string | null;
          },
          method,
          call,
          ctx,
          hash,
          ttlMs,
        );
      }
    }

    const maxAttempts = (this.options.maxRetries ?? 2) + 1;
    for (let attempt = 1; ; attempt++) {
      // The quota is reserved before every live call, retries included.
      if (quota && !(await quota.consume(ctx))) {
        return this.errorOutcome("QUOTA_GUARD_ACTIVE", false, null);
      }
      let result: RawHarnessResult;
      try {
        await this.bucket.acquire(ctx.signal);
        result = await this.semaphore.run(() =>
          transport.call(call, {
            signal: ctx.signal,
            timeoutMs: this.options.timeoutMs ?? 30_000,
          }),
        );
      } catch (error) {
        const te =
          error instanceof TransportError
            ? error
            : new TransportError(
                "PROCESS_FAILED",
                "Harness call failed",
                false,
              );
        if (te.retryable && attempt < maxAttempts) {
          await this.sleep(this.backoff(attempt, te.code));
          continue;
        }
        const envelope: EnvelopeSummary = {
          status: "transport_error",
          shape: "unknown",
          resultCount: null,
          errorCode: te.code,
          retryable: te.retryable,
        };
        const provenance = await this.persist({
          method,
          call,
          ctx,
          hash,
          ttlMs,
          envelope,
          dataOrigin: transport.name === "FIXTURE" ? "FIXTURE" : "LIVE",
          transportName: transport.name,
          attempt,
          latencyMs: null,
        });
        return {
          kind: "ERROR",
          code: te.code,
          retryable: te.retryable,
          envelope,
          provenance,
        };
      }

      const parsed = parseEnvelope(call, result);
      if (parsed.error?.retryable && attempt < maxAttempts) {
        await this.sleep(this.backoff(attempt, parsed.error.code));
        continue;
      }
      const dataOrigin = result.transport === "FIXTURE" ? "FIXTURE" : "LIVE";
      const provenance = await this.persist({
        method,
        call,
        ctx,
        hash,
        ttlMs,
        envelope: parsed.summary,
        parsed,
        raw: result.payload,
        dataOrigin,
        transportName: result.transport,
        attempt,
        latencyMs: result.durationMs,
      });
      const outcome = this.buildOutcome(
        parsed,
        result.payload,
        provenance,
        normalize,
      );
      if (
        cacheable &&
        (outcome.kind === "OK" ||
          outcome.kind === "EMPTY" ||
          outcome.kind === "NEEDS_INPUT")
      ) {
        this.cache.set(
          hash,
          {
            outcome: outcome as QlooOutcome<unknown>,
            toolInvocationId: provenance.toolInvocationId,
          },
          ttlMs,
        );
      }
      return outcome;
    }
  }

  private buildOutcome<T>(
    parsed: ParsedEnvelope,
    raw: unknown,
    provenance: QlooProvenance,
    normalize: (payload: unknown, parsed: ParsedEnvelope) => Normalized<T>,
  ): QlooOutcome<T> {
    const envelope = parsed.summary;
    switch (envelope.status) {
      case "ok":
      case "partial":
      case "degraded": {
        const { items } = normalize(raw, parsed);
        if (
          items.length === 0 &&
          envelope.status === "ok" &&
          envelope.resultCount === 0
        ) {
          return {
            kind: "EMPTY",
            summary: parsed.summaryText,
            envelope,
            provenance,
            raw,
          };
        }
        const quality =
          envelope.status === "ok"
            ? "FULL"
            : envelope.status === "partial"
              ? "PARTIAL"
              : "DEGRADED";
        return {
          kind: "OK",
          items,
          quality,
          summary: parsed.summaryText,
          resolution: parsed.resolution,
          envelope,
          provenance,
          raw,
        };
      }
      case "empty":
        return {
          kind: "EMPTY",
          summary: parsed.summaryText,
          envelope,
          provenance,
          raw,
        };
      case "needs_input":
        return {
          kind: "NEEDS_INPUT",
          summary: parsed.summaryText,
          resolution: parsed.resolution ?? {
            entities: [],
            tags: [],
            provenance: [],
          },
          envelope,
          provenance,
          raw,
        };
      default:
        return {
          kind: "ERROR",
          code: parsed.error?.code ?? "UNKNOWN_ERROR",
          retryable: parsed.error?.retryable ?? false,
          recovery: parsed.error?.recovery,
          envelope,
          provenance,
        };
    }
  }

  private errorOutcome<T>(
    code: string,
    retryable: boolean,
    provenance: QlooProvenance | null,
  ): QlooOutcome<T> {
    return {
      kind: "ERROR",
      code,
      retryable,
      envelope: {
        status: "error",
        shape: "unknown",
        resultCount: null,
        errorCode: code,
        retryable,
      },
      provenance,
    };
  }

  private async fromCache<T>(
    hit: {
      outcome: Exclude<QlooOutcome<T>, { kind: "UNSUPPORTED" | "ERROR" }>;
      toolInvocationId: string | null;
    },
    method: string,
    call: HarnessCall,
    ctx: CallContext,
    hash: string,
    ttlMs: number,
  ): Promise<QlooOutcome<T>> {
    const original = hit.outcome.provenance;
    let ids: { toolInvocationId: string | null; snapshotId: string | null } = {
      toolInvocationId: null,
      snapshotId: original.snapshotId,
    };
    // A cache hit gets its own invocation row pointing at the original (DB check requires it).
    if (this.options.recorder && hit.toolInvocationId) {
      ids = await this.options.recorder.record({
        ctx,
        method,
        workflow: this.workflowName(call),
        transport: original.transport,
        args: call.args,
        requestHash: hash,
        harnessVersion: this.options.harnessVersion,
        dataOrigin: "CACHE",
        cacheSourceInvocationId: hit.toolInvocationId,
        envelope: hit.outcome.envelope,
        attempt: 1,
        latencyMs: 0,
        retrievedAt: new Date(original.retrievedAt),
        ttlMs,
      });
    }
    return {
      ...hit.outcome,
      provenance: { ...original, ...ids, dataOrigin: "CACHE" },
    };
  }

  private async persist(input: {
    method: string;
    call: HarnessCall;
    ctx: CallContext;
    hash: string;
    ttlMs: number;
    envelope: EnvelopeSummary;
    parsed?: ParsedEnvelope;
    raw?: unknown;
    dataOrigin: "LIVE" | "FIXTURE";
    transportName: QlooTransport;
    attempt: number;
    latencyMs: number | null;
  }): Promise<QlooProvenance> {
    const retrievedAt = new Date(this.now());
    const workflow = this.workflowName(input.call);
    let ids: { toolInvocationId: string | null; snapshotId: string | null } = {
      toolInvocationId: null,
      snapshotId: null,
    };
    if (this.options.recorder) {
      ids = await this.options.recorder.record({
        ctx: input.ctx,
        method: input.method,
        workflow,
        transport: input.transportName,
        args: input.call.args,
        requestHash: input.hash,
        harnessVersion: this.options.harnessVersion,
        dataOrigin: input.dataOrigin,
        envelope: input.envelope,
        parsed: input.parsed,
        raw: input.raw,
        attempt: input.attempt,
        latencyMs: input.latencyMs,
        retrievedAt,
        ttlMs: input.ttlMs,
      });
    }
    return {
      ...ids,
      transport: input.transportName,
      workflow,
      harnessVersion: this.options.harnessVersion,
      requestHash: input.hash,
      dataOrigin: input.dataOrigin,
      retrievedAt: retrievedAt.toISOString(),
      correlationId: input.parsed?.correlationId,
      endpoint: input.parsed?.endpoint,
      requests: input.parsed?.requests ?? [],
    };
  }
}
