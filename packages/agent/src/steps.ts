import {
  CritiqueReport,
  HypothesisBatch,
  HypothesisRevision,
  IntentFrame,
  uuidv7,
  type BriefInput,
  type GuardContext,
  type RunEventName,
  type ClaimParams,
  type ClaimTestKind,
  type EvidenceFact,
  type EvidenceStance,
  type ExperimentVariables,
  type HypothesisDraft,
  type HypothesisStatus,
  type QlooMeasure,
  type RunBudget,
  type RunConfig,
  type RunKind,
  type RunState,
  type RunUsage,
} from "@tessaloom/core";
import type { z } from "zod";
import {
  addUsage as addUsageLocal,
  remaining,
  type UsageDelta,
} from "./budget";
import { buildCollisionPool, type ThreadItem } from "./collision";
import { EVALUATION_RULESET, evaluateClaim } from "./evaluators";
import {
  checkTermination,
  computeStatus,
  scoreHypothesis,
  type ClaimState,
} from "./hypothesis";
import { planEvidence, type PlanEntity, type PlannedQuery } from "./planner";
import type {
  LlmPort,
  LlmResult,
  QlooPort,
  QlooProvenanceLike,
  QlooResult,
  ResolutionCandidatesLike,
} from "./ports";
import {
  combine,
  critiqueValidator,
  hypothesisBatchValidator,
  hypothesisRevisionValidator,
  safeUseValidator,
  type ValidationIssue,
} from "./validators";

// ---------------------------------------------------------------------------
// Read-only step context (built by the worker from the database)

export interface EntityView {
  id: string;
  kind: "entity" | "tag" | "locality";
  qlooId: string;
  name: string;
  domain: string | null;
}

export interface ClaimView {
  id: string;
  ordinal: number;
  statement: string;
  testKind: ClaimTestKind;
  params: ClaimParams;
  status: "PLANNED" | "TESTED" | "UNTESTED_BUDGET" | "UNSUPPORTED" | "FAILED";
  stance: EvidenceStance | null;
}

export interface HypothesisView {
  id: string;
  lineageId: string;
  revisionOfId: string | null;
  iteration: number;
  title: string;
  premise: string;
  experienceSketch: string;
  status: HypothesisStatus;
  retired: boolean;
  compositeScore: number | null;
  collisionCandidateId: string | null;
  scoreBreakdown: Record<string, unknown> | null;
  elements: { entityId: string; role: string }[];
  claims: ClaimView[];
  evidence: {
    id: string;
    claimId: string;
    stance: EvidenceStance;
    toolInvocationId: string | null;
  }[];
}

export interface StepContext {
  run: {
    id: string;
    kind: RunKind;
    state: RunState;
    stateVersion: number;
    iteration: number;
    budget: RunBudget;
    usage: RunUsage;
    config: RunConfig;
    elapsedSeconds: number;
  };
  experiment: {
    id: string;
    projectId: string;
    variables: ExperimentVariables;
    scoringWeights: { support: number; novelty: number; feasibility: number };
  };
  brief: {
    versionId: string;
    content: BriefInput;
    intentFrame: IntentFrame | null;
  };
  resolutions: {
    id: string;
    interestIndex: number;
    inputText: string;
    domainHint: string | null;
    status: "PENDING" | "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" | "EXCLUDED";
    selectedEntityId: string | null;
  }[];
  seeds: EntityView[];
  entities: ReadonlyMap<string, EntityView>;
  threads: { seedId: string; entityId: string; position: number }[];
  pool: {
    id: string;
    elementEntityIds: string[];
    novelty: number;
    rank: number | null;
    noveltyInputs: string;
  }[];
  hypotheses: HypothesisView[];
  today: string; // YYYY-MM-DD
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Step result: what the worker commits atomically

export type EntityRef =
  string | { kind: "entity" | "tag" | "locality"; qlooId: string };
export type Provenance = "QLOO_SOURCED" | "DEVELOPMENT_FIXTURE";

export interface CommitPlan {
  intent?: {
    briefVersionId: string;
    intentFrame: IntentFrame;
    llmInvocationId: string;
  };
  entities?: {
    kind: "entity" | "tag" | "locality";
    qlooId: string;
    name: string;
    qlooType?: string | null;
    domain?: string | null;
    disambiguation?: string | null;
    snapshot: Record<string, unknown>;
    sourceToolInvocationId: string | null;
    provenanceClass: Provenance;
  }[];
  resolutions?: {
    existingId: string | null;
    interestIndex: number;
    inputText: string;
    domainHint: string | null;
    candidates: ResolutionCandidatesLike;
    toolInvocationIds: string[];
    status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
    selected: EntityRef | null;
  }[];
  seeds?: EntityRef[];
  relations?: {
    from: EntityRef;
    to: EntityRef;
    kind:
      | "THREAD"
      | "BRIDGE_SHARED_TAG"
      | "BRIDGE_CO_OCCURRENCE"
      | "HAS_TAG"
      | "POPULAR_IN";
    provenanceClass: Provenance;
    toolInvocationIds: string[];
    facts: EvidenceFact[];
    weight: number | null;
  }[];
  collisionCandidates?: {
    elementEntityIds: string[];
    relevance: number;
    novelty: number;
    tensionFit: number;
    noveltyInputs: "FULL" | "REDUCED_INPUTS";
    selected: boolean;
    rank: number | null;
  }[];
  hypotheses?: {
    draft: HypothesisDraft;
    llmInvocationId: string;
    iteration: number;
    revisionOfId: string | null;
    lineageId: string | null;
    collisionCandidateId: string | null;
  }[];
  hypothesisUpdates?: {
    id: string;
    status?: HypothesisStatus;
    supportScore?: number;
    noveltyScore?: number;
    feasibilityScore?: number;
    compositeScore?: number;
    scoreBreakdown?: Record<string, unknown>;
    retired?: boolean;
  }[];
  claimOutcomes?: {
    claimId: string;
    status: ClaimView["status"];
    stance?: EvidenceStance | null;
    queryRequestHash?: string | null;
  }[];
  evidence?: {
    id: string;
    claimId: string;
    hypothesisId: string;
    toolInvocationId: string;
    stance: EvidenceStance;
    evaluatorId: string;
    rulesetVersion: string;
    facts: EvidenceFact[];
    primaryMeasure: QlooMeasure;
    quality:
      | "FULL"
      | "PARTIAL"
      | "DEGRADED"
      | "FIELD_UNAVAILABLE"
      | "UNSUPPORTED"
      | "ERROR";
    provenanceClass: Provenance;
  }[];
}

export interface StepEvent {
  type: string;
  role?: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | null;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface StepResult {
  event: RunEventName;
  guard: GuardContext;
  commit: CommitPlan;
  events: StepEvent[];
  usage: UsageDelta;
  iteration?: number;
  pendingConfirmation?: Record<string, unknown> | null;
  terminalReason?: string | null;
  error?: { code: string; message: string } | null;
  /** Retry the job instead of failing (transient provider unavailability). */
  transient?: boolean;
}

export interface Ports {
  qloo: QlooPort;
  llm: LlmPort | null;
}

// ---------------------------------------------------------------------------
// Helpers

const INSIGHT = new Set([
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
]);
const MAX_OUTPUT = { R1: 4000, R3: 12000, R4: 6000 } as const;

const truncate = (s: string, n = 280) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/** `urn:entity:book` → `book`. */
export function domainFromType(type?: string | null): string | null {
  if (!type) return null;
  const m = /^urn:entity:([a-z_]+)$/.exec(type);
  return m ? m[1]! : null;
}

const provenanceOf = (p: QlooProvenanceLike | null | undefined): Provenance =>
  p?.dataOrigin === "FIXTURE" ? "DEVELOPMENT_FIXTURE" : "QLOO_SOURCED";

function base(event: RunEventName, guard: GuardContext = {}): StepResult {
  return { event, guard, commit: {}, events: [], usage: {} };
}

function fatal(
  code: string,
  message: string,
  extra: Partial<StepResult> = {},
): StepResult {
  return {
    ...base("FATAL_ERROR"),
    terminalReason: code,
    error: { code, message },
    ...extra,
  };
}

class Cancelled extends Error {}

function failLlm(
  result: Extract<LlmResult<unknown>, { ok: false }>,
  label: string,
  acc: StepResult,
): StepResult {
  const carry = { events: acc.events, usage: acc.usage, commit: acc.commit };
  switch (result.reason) {
    case "BUDGET":
      return {
        ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
        ...carry,
        terminalReason: "BUDGET:LLM",
      };
    case "CANCELLED":
      return { ...base("CANCEL"), ...carry, terminalReason: "USER_CANCELLED" };
    case "REFUSED":
      return fatal(
        "LLM_REFUSED",
        "The model declined this request. Try rephrasing the brief.",
        carry,
      );
    case "TRUNCATED":
      return fatal(
        "LLM_OUTPUT_TRUNCATED",
        `${label}: output exceeded its length limit`,
        carry,
      );
    case "INVALID_OUTPUT":
      return fatal(
        "LLM_INVALID_OUTPUT",
        `${label}: output failed validation after one repair`,
        carry,
      );
    case "UNAVAILABLE":
      return fatal(
        "LLM_UNAVAILABLE",
        `${label}: the model provider is unavailable`,
        { ...carry, transient: true },
      );
    case "CONFIGURATION":
      return fatal(
        "LLM_NOT_CONFIGURED",
        `${label}: the LLM provider is not configured`,
        carry,
      );
  }
}

/** Shared LLM call: budget context, usage accounting, and activity events. */
async function llmCall<S extends z.ZodType>(
  ctx: StepContext,
  ports: Ports,
  acc: StepResult,
  req: {
    role: "R1" | "R3" | "R4" | "R5" | "R6";
    promptId: string;
    label: string;
    input: unknown;
    inputExcerpt?: Record<string, unknown>;
    schema: S;
    maxOutputTokens: number;
    validate?: (value: z.output<S>) => ValidationIssue[];
  },
): Promise<LlmResult<z.output<S>>> {
  if (!ports.llm)
    return {
      ok: false,
      reason: "CONFIGURATION",
      invocationIds: [],
      modelId: null,
      fallbackUsed: false,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      costUsd: 0,
      attempts: 0,
    };
  const left = remaining(ctx.run.budget, ctx.run.usage, ctx.run.elapsedSeconds);
  const { label, ...rest } = req;
  const result = (await ports.llm.generate({
    ...rest,
    effort: ctx.run.config.effortByRole[req.role],
    ctx: {
      projectId: ctx.experiment.projectId,
      runId: ctx.run.id,
      signal: ctx.signal,
      remainingUsd: left.costUsd,
      remainingCalls: left.llmCalls,
      remainingOutputTokens: left.llmOutputTokens,
    },
  })) as LlmResult<z.output<S>>;
  acc.usage = {
    ...acc.usage,
    llmCalls: (acc.usage.llmCalls ?? 0) + result.attempts,
    llmInputTokens:
      (acc.usage.llmInputTokens ?? 0) +
      result.usage.inputTokens +
      result.usage.cachedInputTokens +
      result.usage.cacheWriteTokens,
    llmOutputTokens:
      (acc.usage.llmOutputTokens ?? 0) + result.usage.outputTokens,
    estimatedCostUsd: (acc.usage.estimatedCostUsd ?? 0) + result.costUsd,
  };
  const payload = {
    promptId: req.promptId,
    modelId: result.modelId,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
    invocationIds: result.invocationIds,
    outputTokens: result.usage.outputTokens,
    costUsd: Number(result.costUsd.toFixed(6)),
  };
  if (result.attempts > 1)
    acc.events.push({
      type: "REPAIR_ATTEMPTED",
      role: req.role,
      summary: truncate(
        `${label}: retried after validation, truncation, or availability issue`,
      ),
      payload,
    });
  acc.events.push({
    type: "LLM_CALL_FINISHED",
    role: req.role,
    summary: truncate(
      `${label} → ${result.ok ? "valid output" : result.reason.toLowerCase()} (${result.modelId ?? "no model"}, ${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`,
    ),
    payload,
  });
  acc.events.push(
    result.ok
      ? {
          type: "VALIDATION_PASSED",
          role: req.role,
          summary: truncate(`${label}: schema and semantic validators passed`),
        }
      : {
          type: "VALIDATION_FAILED",
          role: req.role,
          summary: truncate(`${label}: ${result.reason}`),
          payload: {
            issues: (result.issues ?? [])
              .slice(0, 10)
              .map((i) => ({ code: i.code, path: i.path ?? null })),
          },
        },
  );
  return result;
}

/** Shared Qloo call: cancellation, quota usage, and tool events (no raw data in events). */
async function qlooCall<T>(
  ctx: StepContext,
  acc: StepResult,
  method: string,
  call: () => Promise<QlooResult<T>>,
  label: string,
): Promise<QlooResult<T>> {
  if (ctx.signal?.aborted) throw new Cancelled();
  const result = await call();
  if (ctx.signal?.aborted) throw new Cancelled();
  const prov = "provenance" in result ? result.provenance : null;
  if (result.kind !== "UNSUPPORTED" && prov?.dataOrigin !== "CACHE")
    acc.usage = { ...acc.usage, qlooCalls: (acc.usage.qlooCalls ?? 0) + 1 };
  const count = result.kind === "OK" ? result.items.length : 0;
  acc.events.push({
    type: "TOOL_CALL_FINISHED",
    role: null,
    summary: truncate(
      `qloo ${method} → ${label}: ${result.kind.toLowerCase()}${result.kind === "OK" ? ` (${count})` : ""}${result.kind === "ERROR" ? ` ${result.code}` : ""}`,
    ),
    payload: {
      method,
      toolInvocationId: prov?.toolInvocationId ?? null,
      outcome: result.kind,
      resultCount: count,
      dataOrigin: prov?.dataOrigin ?? null,
    },
  });
  return result;
}

function qlooFailure(result: QlooResult<unknown>): StepResult | null {
  if (result.kind !== "ERROR") return null;
  if (result.code === "QLOO_AUTH")
    return fatal("QLOO_UNAVAILABLE", "Qloo rejected the credential");
  if (result.code === "QLOO_NOT_CONFIGURED")
    return fatal(
      "QLOO_UNAVAILABLE",
      "Qloo access is not configured for this worker",
    );
  if (result.code === "QUOTA_GUARD_ACTIVE")
    return {
      ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
      terminalReason: "QUOTA_GUARD_ACTIVE",
    };
  return null;
}

const qctx = (ctx: StepContext, purpose: string) => ({
  projectId: ctx.experiment.projectId,
  runId: ctx.run.id,
  stepSeq: ctx.run.stateVersion,
  purpose,
  signal: ctx.signal,
});

// ---------------------------------------------------------------------------
// Handlers

async function analyzeIntent(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("INTENT_READY");
  const result = await llmCall(ctx, ports, acc, {
    role: "R1",
    promptId: "r1.intent",
    label: "R1 intent analysis",
    input: { brief: ctx.brief.content },
    inputExcerpt: {
      briefVersionId: ctx.brief.versionId,
      interestCount: ctx.brief.content.interests.length,
    },
    schema: IntentFrame,
    maxOutputTokens: MAX_OUTPUT.R1,
    validate: safeUseValidator,
  });
  if (!result.ok) return failLlm(result, "R1 intent analysis", acc);
  acc.commit.intent = {
    briefVersionId: ctx.brief.versionId,
    intentFrame: result.value,
    llmInvocationId: result.invocationIds.at(-1)!,
  };
  acc.guard = { intentValid: true };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R1",
    summary: truncate(result.value.decisionSummary),
  });
  acc.pendingConfirmation = {
    kind: "BRIEF",
    briefVersionId: ctx.brief.versionId,
  };
  return acc;
}

async function resolveEntities(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("RESOLUTION_COMPLETE");
  const interests = ctx.brief.content.interests;
  const statuses: string[] = [];
  const resolutions: NonNullable<CommitPlan["resolutions"]> = [];
  const entities: NonNullable<CommitPlan["entities"]> = [];
  const needInput: number[] = [];

  for (let i = 0; i < interests.length; i++) {
    const latest = ctx.resolutions.find((r) => r.interestIndex === i);
    if (latest && latest.status !== "PENDING") {
      statuses.push(latest.status);
      if (latest.status === "AMBIGUOUS" || latest.status === "UNRESOLVED")
        needInput.push(i);
      continue;
    }
    const text = latest?.inputText ?? interests[i]!.text;
    const guessed = ctx.brief.intentFrame?.interests[i]?.guessedDomain;
    const hint =
      latest?.domainHint ??
      interests[i]!.domainHint ??
      (guessed && guessed !== "unknown" ? guessed : null);
    const type = hint && INSIGHT.has(hint) ? (hint as "book") : undefined;
    const result = await qlooCall(
      ctx,
      acc,
      "describeEntity",
      () =>
        ports.qloo.describeEntity(
          { entity: text, ...(type ? { type } : {}) },
          qctx(ctx, `resolve:interest:${i}`),
        ),
      `"${truncate(text, 40)}"`,
    );
    const failed = qlooFailure(result);
    if (failed) return { ...failed, events: acc.events, usage: acc.usage };
    const invocationIds =
      "provenance" in result && result.provenance?.toolInvocationId
        ? [result.provenance.toolInvocationId]
        : [];
    const empty: ResolutionCandidatesLike = {
      entities: [],
      tags: [],
      provenance: [],
    };
    const candidates =
      result.kind === "OK"
        ? (result.resolution ?? empty)
        : result.kind === "NEEDS_INPUT"
          ? result.resolution
          : empty;
    let status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" =
      candidates.entities.length + candidates.tags.length > 1
        ? "AMBIGUOUS"
        : "UNRESOLVED";
    let selected: EntityRef | null = null;
    // EXACT_SINGLE: exactly one candidate and the described entity is that candidate.
    if (
      result.kind === "OK" &&
      candidates.entities.length === 1 &&
      candidates.tags.length === 0
    ) {
      const item = result.items.find(
        (e) => e.qlooId === candidates.entities[0]!.qlooId,
      );
      if (item) {
        const kind =
          domainFromType(candidates.entities[0]!.type ?? item.type) ===
          "locality"
            ? "locality"
            : "entity";
        entities.push({
          kind,
          qlooId: item.qlooId,
          name: item.name,
          qlooType: candidates.entities[0]!.type ?? item.type ?? null,
          domain: domainFromType(candidates.entities[0]!.type ?? item.type),
          disambiguation:
            item.disambiguation ??
            candidates.entities[0]!.disambiguation ??
            null,
          snapshot: {
            popularity: item.popularity ?? null,
            description: item.description ?? null,
            missingFields: item.missingFields,
          },
          sourceToolInvocationId: invocationIds[0] ?? null,
          provenanceClass: provenanceOf(result.provenance),
        });
        selected = { kind, qlooId: item.qlooId };
        status = "RESOLVED";
      }
    }
    if (status !== "RESOLVED") needInput.push(i);
    statuses.push(status);
    resolutions.push({
      existingId: latest?.id ?? null,
      interestIndex: i,
      inputText: text,
      domainHint: hint ?? null,
      candidates,
      toolInvocationIds: invocationIds,
      status,
      selected,
    });
  }
  acc.commit.entities = entities;
  acc.commit.resolutions = resolutions;
  acc.guard = { resolutionStatuses: statuses };
  if (needInput.length > 0) {
    acc.event = "RESOLUTION_AMBIGUOUS";
    acc.pendingConfirmation = { kind: "ENTITIES", interestIndexes: needInput };
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: "R2",
      summary: truncate(
        `${statuses.length - needInput.length} of ${statuses.length} interests resolved; ${needInput.length} need your confirmation`,
      ),
    });
  } else {
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: "R2",
      summary: truncate(
        `All ${statuses.length} interests resolved or excluded`,
      ),
    });
  }
  return acc;
}

async function discover(ctx: StepContext, ports: Ports): Promise<StepResult> {
  const acc = base("DISCOVERY_DONE");
  let seeds = ctx.seeds;
  if (seeds.length === 0) {
    seeds = ctx.resolutions
      .filter((r) => r.status === "RESOLVED" && r.selectedEntityId)
      .map((r) => ctx.entities.get(r.selectedEntityId!))
      .filter((e): e is EntityView => !!e && e.kind === "entity");
    acc.commit.seeds = seeds.map((s) => s.id);
  }
  const targets = ctx.experiment.variables.targetDomains.filter((d) =>
    INSIGHT.has(d),
  );
  const calls = seeds.flatMap((s) =>
    targets.filter((t) => t !== s.domain).map((t) => ({ seed: s, target: t })),
  );
  const left = remaining(
    ctx.run.budget,
    ctx.run.usage,
    ctx.run.elapsedSeconds,
  ).qlooCalls;
  let ok = 0;
  const entities: NonNullable<CommitPlan["entities"]> = [];
  const relations: NonNullable<CommitPlan["relations"]> = [];
  for (const { seed, target } of calls.slice(0, left)) {
    const result = await qlooCall(
      ctx,
      acc,
      "recommend",
      () =>
        ports.qloo.recommend(
          { targetType: target as "book", signals: [seed.qlooId], limit: 10 },
          qctx(ctx, `discover:${seed.id}:${target}`),
        ),
      `${target} for "${truncate(seed.name, 40)}"`,
    );
    const failed = qlooFailure(result);
    if (failed) return { ...failed, events: acc.events, usage: acc.usage };
    if (result.kind !== "OK" || !result.provenance.toolInvocationId) continue;
    ok++;
    const prov = result.provenance;
    result.items.forEach((item, position) => {
      if (item.qlooId === seed.qlooId) return;
      // Another seed in this thread: link to it, never overwrite the resolved seed record.
      const seedHit = seeds.find((s) => s.qlooId === item.qlooId);
      if (!seedHit)
        entities.push({
          kind: "entity",
          qlooId: item.qlooId,
          name: item.name,
          qlooType: item.type ?? null,
          domain: domainFromType(item.type) ?? target,
          snapshot: {
            popularity: item.popularity ?? null,
            affinity: item.affinity ?? null,
            missingFields: item.missingFields,
          },
          sourceToolInvocationId: prov.toolInvocationId,
          provenanceClass: provenanceOf(prov),
        });
      relations.push({
        from: seed.id,
        to: seedHit ? seedHit.id : { kind: "entity", qlooId: item.qlooId },
        kind: "THREAD",
        provenanceClass: provenanceOf(prov),
        toolInvocationIds: [prov.toolInvocationId!],
        facts:
          typeof item.affinity === "number"
            ? [
                {
                  statement: `Rank ${position + 1} for audiences of ${truncate(seed.name, 60)}`,
                  jsonPointer: `/results/${position}/affinity`,
                  value: item.affinity,
                  measure: "AUDIENCE_AFFINITY",
                  verifiedAtIngest:
                    rawAffinityAt(result.raw, position, item.qlooId) ===
                    item.affinity,
                },
              ]
            : [],
        weight: Number((1 - position / 10).toFixed(4)),
      });
    });
  }
  acc.commit.entities = entities;
  acc.commit.relations = relations;
  acc.guard = { discoveryOkQueries: ok };
  if (ok === 0) {
    acc.event = "DISCOVERY_EMPTY";
    acc.terminalReason = "NO_DISCOVERY_DATA";
    acc.error = {
      code: "NO_DISCOVERY_DATA",
      message: "No discovery query returned data",
    };
  }
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R2",
    summary: truncate(
      `Expanded ${seeds.length} seeds across ${targets.length} domains: ${ok} of ${Math.min(calls.length, left)} queries returned data`,
    ),
  });
  return acc;
}

function rawAffinityAt(
  raw: unknown,
  position: number,
  qlooId: string,
): unknown {
  const results = (raw as { results?: Record<string, unknown>[] } | null)
    ?.results;
  const row = Array.isArray(results) ? results[position] : undefined;
  return row && (row.entity_id === qlooId || row.id === qlooId)
    ? row.affinity
    : undefined;
}

function buildPool(ctx: StepContext): StepResult {
  const acc = base("POOL_READY");
  const threads = new Map<string, ThreadItem[]>();
  for (const t of ctx.threads) {
    const e = ctx.entities.get(t.entityId);
    if (!e?.domain) continue;
    const list = threads.get(t.seedId) ?? [];
    list.push({
      entityId: t.entityId,
      domain: e.domain,
      position: t.position,
      tagIds: [],
    });
    threads.set(t.seedId, list);
  }
  const candidates = buildCollisionPool({
    seeds: ctx.seeds
      .filter((s) => s.domain)
      .map((s) => ({ entityId: s.id, domain: s.domain!, tagIds: [] })),
    threads,
    tension: ctx.experiment.variables.collisionTension,
  });
  const selected = candidates.filter((c) => c.selected);
  const extra = candidates
    .filter((c) => !c.selected)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10);
  acc.commit.collisionCandidates = [...selected, ...extra].map((c) => ({
    elementEntityIds: c.elementEntityIds,
    relevance: c.relevance,
    novelty: c.novelty,
    tensionFit: c.tensionFit,
    noveltyInputs: c.noveltyInputs,
    selected: c.selected,
    rank: c.rank,
  }));
  acc.guard = { poolSize: selected.length };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: null,
    summary: truncate(
      `Collision pool: ${selected.length} candidates selected from ${candidates.length} bridges (tension ${ctx.experiment.variables.collisionTension})`,
    ),
  });
  if (selected.length < 3)
    return {
      ...fatal("POOL_TOO_SMALL", "Fewer than 3 collision candidates"),
      events: acc.events,
    };
  return acc;
}

function groundingContext(ctx: StepContext) {
  const ids = new Set<string>([
    ...ctx.seeds.map((s) => s.id),
    ...ctx.pool.flatMap((p) => p.elementEntityIds),
  ]);
  for (const h of ctx.hypotheses)
    h.elements.forEach((e) => ids.add(e.entityId));
  const domainOf = new Map<string, string>();
  for (const id of ids) {
    const d = ctx.entities.get(id)?.domain;
    if (d) domainOf.set(id, d);
  }
  return {
    entityIds: ids,
    tagIds: new Set(
      [...ids].filter((id) => ctx.entities.get(id)?.kind === "tag"),
    ),
    domainOf,
    maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
  };
}

function poolInput(ctx: StepContext) {
  const view = (id: string) => {
    const e = ctx.entities.get(id);
    return {
      entityId: id,
      name: e?.name ?? "unknown",
      domain: e?.domain ?? null,
    };
  };
  return {
    seeds: ctx.seeds.map((s) => view(s.id)),
    pool: ctx.pool.map((p) => ({
      candidateId: p.id,
      rank: p.rank,
      elements: p.elementEntityIds.map(view),
      noveltyInputs: p.noveltyInputs,
    })),
  };
}

function matchCandidate(
  ctx: StepContext,
  draft: HypothesisDraft,
): string | null {
  const ids = new Set(draft.elementRefs.map((r) => r.entityId));
  return (
    ctx.pool.find((p) => p.elementEntityIds.every((id) => ids.has(id)))?.id ??
    null
  );
}

const allowedKinds = (ctx: StepContext) => [
  "CROSS_DOMAIN_AFFINITY",
  "SHORTLIST_FIT",
  "AUDIENCE_BRIDGE",
  "TAG_RESONANCE",
  "MOMENTUM",
  "AUDIENCE_PROFILE",
  ...(ctx.experiment.variables.locationQlooId ? ["LOCATION_FIT"] : []),
];

async function generateHypotheses(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("HYPOTHESES_READY");
  const grounding = groundingContext(ctx);
  const result = await llmCall(ctx, ports, acc, {
    role: "R3",
    promptId: "r3.generate",
    label: "R3 hypothesis generation",
    input: {
      brief: {
        title: ctx.brief.content.title,
        challenge: ctx.brief.content.challenge,
        goals: ctx.brief.content.goals,
        venue: ctx.brief.content.venue,
        constraints: ctx.brief.content.constraints,
      },
      ...poolInput(ctx),
      limits: {
        maxHypotheses: ctx.run.budget.maxHypotheses,
        maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
      },
      allowedTestKinds: allowedKinds(ctx),
    },
    inputExcerpt: {
      poolSize: ctx.pool.length,
      seedCount: ctx.seeds.length,
      iteration: ctx.run.iteration,
    },
    schema: HypothesisBatch,
    maxOutputTokens: MAX_OUTPUT.R3,
    validate: combine(hypothesisBatchValidator(grounding), safeUseValidator),
  });
  if (!result.ok) return failLlm(result, "R3 hypothesis generation", acc);
  const drafts = result.value.hypotheses.slice(
    0,
    Math.max(1, ctx.run.budget.maxHypotheses),
  );
  const invocationId = result.invocationIds.at(-1)!;
  acc.commit.hypotheses = drafts.map((draft) => ({
    draft,
    llmInvocationId: invocationId,
    iteration: ctx.run.iteration,
    revisionOfId: null,
    lineageId: null,
    collisionCandidateId: matchCandidate(ctx, draft),
  }));
  acc.guard = { validHypotheses: drafts.length };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R3",
    summary: truncate(result.value.decisionSummary),
  });
  return acc;
}

const active = (ctx: StepContext) => ctx.hypotheses.filter((h) => !h.retired);

function makePlan(ctx: StepContext) {
  const entities = new Map<string, PlanEntity>();
  for (const [id, e] of ctx.entities)
    entities.set(id, { qlooId: e.qlooId, domain: e.domain, kind: e.kind });
  return planEvidence({
    claims: active(ctx).flatMap((h) =>
      h.claims
        .filter((c) => c.status === "PLANNED")
        .map((c) => ({
          claimId: c.id,
          hypothesisId: h.id,
          testKind: c.testKind,
          params: c.params,
          priority: h.compositeScore,
          ordinal: c.ordinal,
        })),
    ),
    entities,
    remainingQlooCalls: remaining(
      ctx.run.budget,
      ctx.run.usage,
      ctx.run.elapsedSeconds,
    ).qlooCalls,
    locationQlooId: ctx.experiment.variables.locationQlooId,
    timeWindowWeeks: ctx.experiment.variables.timeWindowWeeks,
    today: ctx.today,
  });
}

function planStep(ctx: StepContext): StepResult {
  const acc = base("PLAN_READY");
  const plan = makePlan(ctx);
  acc.commit.claimOutcomes = [
    ...plan.untestedBudget.map((claimId) => ({
      claimId,
      status: "UNTESTED_BUDGET" as const,
    })),
    ...plan.unsupported.map((u) => ({
      claimId: u.claimId,
      status: "UNSUPPORTED" as const,
    })),
  ];
  const planned = new Set(plan.queries.flatMap((q) => q.claimIds));
  acc.commit.hypothesisUpdates = active(ctx)
    .filter((h) => h.claims.some((c) => planned.has(c.id)))
    .map((h) => ({ id: h.id, status: "UNDER_INVESTIGATION" as const }));
  acc.guard = {
    planWithinBudget:
      plan.queries.length <=
      remaining(ctx.run.budget, ctx.run.usage, ctx.run.elapsedSeconds)
        .qlooCalls,
  };
  if (plan.queries.length === 0 && plan.untestedBudget.length > 0) {
    // Termination rule 4: no planned query fits the remaining Qloo budget.
    acc.event = "BUDGET_EXHAUSTED";
    acc.guard = { outputsConsistent: true };
    acc.terminalReason = "BUDGET:maxQlooCalls";
  }
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(
      `Evidence plan: ${plan.queries.length} Qloo queries for ${planned.size} claims; ${plan.untestedBudget.length} trimmed by budget; ${plan.unsupported.length} untestable`,
    ),
    payload: {
      queries: plan.queries.map((q) => ({
        method: q.method,
        claims: q.claimIds.length,
      })),
    },
  });
  return acc;
}

async function runQuery(
  ports: Ports,
  q: PlannedQuery,
  ctx: ReturnType<typeof qctx>,
): Promise<QlooResult<unknown>> {
  const i = q.input as never;
  switch (q.method) {
    case "recommend":
      return ports.qloo.recommend(i, ctx);
    case "rank":
      return ports.qloo.rank(i, ctx);
    case "compareAudiences":
      return ports.qloo.compareAudiences(i, ctx);
    case "entityTags":
      return ports.qloo.entityTags(i, ctx);
    case "wherePopular":
      return ports.qloo.wherePopular(i, ctx);
    case "trends":
      return ports.qloo.trends(i, ctx);
    case "audienceDemographics":
      return ports.qloo.audienceDemographics(i, ctx);
  }
}

async function collect(ctx: StepContext, ports: Ports): Promise<StepResult> {
  const acc = base("COLLECTION_DONE");
  const plan = makePlan(ctx);
  const claims = new Map(
    active(ctx).flatMap((h) =>
      h.claims.map((c) => [c.id, { claim: c, hypothesisId: h.id }] as const),
    ),
  );
  const outcomes: NonNullable<CommitPlan["claimOutcomes"]> = [];
  const evidence: NonNullable<CommitPlan["evidence"]> = [];
  let rateLimited = 0;
  for (const q of plan.queries) {
    let result: QlooResult<unknown>;
    try {
      result = await qlooCall(
        ctx,
        acc,
        q.method,
        () => runQuery(ports, q, qctx(ctx, `evidence:${q.claimIds[0]}`)),
        `${q.claimIds.length} claim(s)`,
      );
    } catch (error) {
      // Cancelled mid-collection: keep what was graded so far (AGENT_WORKFLOW §9).
      if (error instanceof Cancelled)
        return {
          ...base("CANCEL"),
          commit: { claimOutcomes: outcomes, evidence },
          events: acc.events,
          usage: acc.usage,
          terminalReason: "USER_CANCELLED",
        };
      throw error;
    }
    const failed = qlooFailure(result);
    if (failed)
      return {
        ...failed,
        events: acc.events,
        usage: acc.usage,
        commit: { claimOutcomes: outcomes, evidence },
      };
    if (result.kind === "ERROR" && /RATE/i.test(result.code)) rateLimited++;
    const prov = "provenance" in result ? result.provenance : null;
    for (const claimId of q.claimIds) {
      const entry = claims.get(claimId)!;
      const evaluation = evaluateClaim(
        entry.claim.testKind,
        plan.resolved.get(claimId)!,
        result,
      );
      const recordable =
        !!prov?.toolInvocationId && evaluation.claimStatus === "TESTED";
      outcomes.push({
        claimId,
        status: recordable
          ? "TESTED"
          : evaluation.claimStatus === "TESTED"
            ? "FAILED"
            : evaluation.claimStatus,
        stance: recordable ? evaluation.stance : null,
        queryRequestHash: prov?.requestHash ?? null,
      });
      if (recordable)
        evidence.push({
          id: uuidv7(),
          claimId,
          hypothesisId: entry.hypothesisId,
          toolInvocationId: prov!.toolInvocationId!,
          stance: evaluation.stance,
          evaluatorId: evaluation.evaluatorId,
          rulesetVersion: EVALUATION_RULESET.version,
          facts: evaluation.facts,
          primaryMeasure: evaluation.primaryMeasure,
          quality: evaluation.quality,
          provenanceClass: provenanceOf(prov),
        });
    }
  }
  acc.commit.claimOutcomes = outcomes;
  acc.commit.evidence = evidence;
  acc.guard = { allQueriesFinal: true };
  if (plan.queries.length > 0 && rateLimited / plan.queries.length >= 0.5)
    return {
      ...base("BUDGET_EXHAUSTED", { outputsConsistent: true }),
      commit: acc.commit,
      events: acc.events,
      usage: acc.usage,
      terminalReason: "RATE_LIMITED",
    };
  const stances = evidence.reduce<Record<string, number>>(
    (m, e) => ({ ...m, [e.stance]: (m[e.stance] ?? 0) + 1 }),
    {},
  );
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(
      `Graded ${evidence.length} claims deterministically: ${
        Object.entries(stances)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ") || "none"
      }`,
    ),
  });
  return acc;
}

function claimStates(
  h: HypothesisView,
  outcomes?: Map<
    string,
    { stance: EvidenceStance | null; status: ClaimView["status"] }
  >,
): ClaimState[] {
  return h.claims.map((c) => {
    const o = outcomes?.get(c.id);
    const latest = [...h.evidence].reverse().find((e) => e.claimId === c.id);
    return {
      stance: o?.stance ?? c.stance,
      status: o?.status ?? c.status,
      toolInvocationId: latest?.toolInvocationId ?? null,
    };
  });
}

async function evaluate(ctx: StepContext, ports: Ports): Promise<StepResult> {
  const acc = base("CONVERGED");
  const hyps = active(ctx);
  const computed = hyps.map((h) => {
    const states = claimStates(h);
    const novelty =
      ctx.pool.find((p) => p.id === h.collisionCandidateId)?.novelty ?? 0.5;
    const scores = scoreHypothesis({
      claims: states,
      novelty,
      feasibility: 0.6,
      weights: ctx.experiment.scoringWeights,
    });
    return { h, status: computeStatus(states), scores };
  });

  const result = await llmCall(ctx, ports, acc, {
    role: "R4",
    promptId: "r4.critique",
    label: "R4 evidence critique",
    input: {
      hypotheses: computed.map(({ h, status }) => ({
        hypothesisId: h.id,
        title: h.title,
        premise: h.premise,
        status,
        claims: h.claims.map((c) => ({
          statement: c.statement,
          testKind: c.testKind,
          status: c.status,
          stance: c.stance,
          evidence: h.evidence
            .filter((e) => e.claimId === c.id)
            .map((e) => ({ evidenceId: e.id, stance: e.stance })),
        })),
      })),
    },
    inputExcerpt: {
      hypothesisCount: hyps.length,
      iteration: ctx.run.iteration,
    },
    schema: CritiqueReport,
    maxOutputTokens: MAX_OUTPUT.R4,
    validate: combine(
      critiqueValidator({
        hypothesisIds: new Set(hyps.map((h) => h.id)),
        evidenceByHypothesis: new Map(
          hyps.map((h) => [h.id, new Set(h.evidence.map((e) => e.id))]),
        ),
      }),
      safeUseValidator,
    ),
  });
  if (!result.ok) return failLlm(result, "R4 evidence critique", acc);
  const critique = new Map(
    result.value.perHypothesis.map((p) => [p.hypothesisId, p]),
  );

  acc.commit.hypothesisUpdates = computed.map(({ h, status, scores }) => {
    const c = critique.get(h.id);
    return {
      id: h.id,
      status,
      supportScore: scores.support,
      noveltyScore: scores.novelty,
      feasibilityScore: scores.feasibility,
      compositeScore: scores.composite,
      scoreBreakdown: {
        ...scores.breakdown,
        feasibilityRule: "baseline-m4",
        // The critic can only add interpretation or a downgrade; it never changes a stance.
        ...(c
          ? {
              critique: {
                recommendation: c.recommendation,
                confidenceNote: c.confidenceNote ?? null,
                downgrade: c.downgrade ?? null,
                citedEvidenceIds: c.citedEvidenceIds,
                refinementHint: c.refinementHint ?? null,
              },
            }
          : {}),
      },
    };
  });

  const previous = new Map<string, HypothesisStatus>();
  for (const { h } of computed) {
    const prior = h.revisionOfId
      ? ctx.hypotheses.find((x) => x.id === h.revisionOfId)
      : h;
    previous.set(h.lineageId, prior?.status ?? h.status);
  }
  const newDecisive = computed
    .filter(({ h }) => h.iteration === ctx.run.iteration)
    .flatMap(({ h }) => h.claims)
    .filter(
      (c) => c.stance === "SUPPORTS" || c.stance === "CONTRADICTS",
    ).length;
  const termination = checkTermination({
    hypotheses: computed.map(({ h, status, scores }) => ({
      id: h.lineageId,
      status,
      composite: scores.composite,
    })),
    previousStatuses: previous,
    newDecisiveStances: newDecisive,
    iteration: ctx.run.iteration,
    maxIterations: ctx.run.budget.maxIterations,
  });
  acc.guard = { terminationMet: termination.met, kind: ctx.run.kind };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R4",
    summary: truncate(result.value.decisionSummary),
  });
  const left = remaining(
    ctx.run.budget,
    addUsageLocal(ctx.run.usage, acc.usage),
    ctx.run.elapsedSeconds,
  );
  if (!termination.met && (left.qlooCalls <= 0 || left.llmCalls < 2)) {
    // Termination rule 4: another revision round (R3 + R4, plus evidence) no longer fits.
    acc.event = "BUDGET_EXHAUSTED";
    acc.guard = { outputsConsistent: true };
    acc.terminalReason =
      left.qlooCalls <= 0 ? "BUDGET:maxQlooCalls" : "BUDGET:maxLlmCalls";
    return acc;
  }
  if (termination.met) {
    const ranked = [...computed]
      .sort((a, b) => b.scores.composite - a.scores.composite)
      .map(({ h }) => h.id);
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: null,
      summary: truncate(
        `Hypothesis loop ended (${termination.rule}) after iteration ${ctx.run.iteration + 1}`,
      ),
      payload: { rule: termination.rule },
    });
    if (ctx.run.kind === "EXPLORATION")
      acc.pendingConfirmation = {
        kind: "HYPOTHESIS_SELECTION",
        hypothesisIds: ranked,
      };
  } else {
    acc.event = "REVISE";
  }
  return acc;
}

async function revise(ctx: StepContext, ports: Ports): Promise<StepResult> {
  const acc = base("REVISION_READY");
  const hyps = active(ctx);
  const grounding = groundingContext(ctx);
  const used = new Set(hyps.flatMap((h) => h.elements.map((e) => e.entityId)));
  const result = await llmCall(ctx, ports, acc, {
    role: "R3",
    promptId: "r3.revise",
    label: "R3 hypothesis revision",
    input: {
      hypotheses: hyps.map((h) => ({
        hypothesisId: h.id,
        title: h.title,
        premise: h.premise,
        status: h.status,
        elements: h.elements,
        claims: h.claims.map((c) => ({
          statement: c.statement,
          testKind: c.testKind,
          params: c.params,
          stance: c.stance,
          status: c.status,
        })),
        critique:
          (h.scoreBreakdown as { critique?: unknown } | null)?.critique ?? null,
      })),
      ...poolInput(ctx),
      unusedPoolEntityIds: [...grounding.entityIds].filter(
        (id) => !used.has(id),
      ),
      limits: {
        maxSpawn: 2,
        maxClaimsPerHypothesis: ctx.run.budget.maxClaimsPerHypothesis,
      },
      allowedTestKinds: allowedKinds(ctx),
    },
    inputExcerpt: {
      hypothesisCount: hyps.length,
      iteration: ctx.run.iteration,
    },
    schema: HypothesisRevision,
    maxOutputTokens: MAX_OUTPUT.R3,
    validate: combine(
      hypothesisRevisionValidator({
        ...grounding,
        hypothesisIds: new Set(hyps.map((h) => h.id)),
      }),
      safeUseValidator,
    ),
  });
  if (!result.ok) return failLlm(result, "R3 hypothesis revision", acc);
  const next = ctx.run.iteration + 1;
  const invocationId = result.invocationIds.at(-1)!;
  const byId = new Map(hyps.map((h) => [h.id, h]));
  acc.commit.hypotheses = [
    ...result.value.refined.map(({ revisionOfId, ...draft }) => ({
      draft,
      llmInvocationId: invocationId,
      iteration: next,
      revisionOfId,
      lineageId: byId.get(revisionOfId)!.lineageId,
      collisionCandidateId: byId.get(revisionOfId)!.collisionCandidateId,
    })),
    ...result.value.spawned.map((draft) => ({
      draft,
      llmInvocationId: invocationId,
      iteration: next,
      revisionOfId: null,
      lineageId: null,
      collisionCandidateId: matchCandidate(ctx, draft),
    })),
  ];
  // Superseded and retired hypotheses stay visible (retired = true); their stances never change.
  acc.commit.hypothesisUpdates = [
    ...result.value.refined.map((r) => ({ id: r.revisionOfId, retired: true })),
    ...result.value.retiredIds.map((id) => ({ id, retired: true })),
  ];
  acc.iteration = next;
  acc.guard = { iterationIncremented: true };
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: "R3",
    summary: truncate(result.value.decisionSummary),
  });
  return acc;
}

/** Execute the handler for the run's current state. Never writes to the database. */
export async function executeStep(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  try {
    switch (ctx.run.state) {
      case "QUEUED":
        return { ...base("START", { kind: ctx.run.kind }) };
      case "ANALYZING_INTENT":
        return await analyzeIntent(ctx, ports);
      case "RESOLVING_ENTITIES":
        return await resolveEntities(ctx, ports);
      case "DISCOVERING":
        return await discover(ctx, ports);
      case "BUILDING_COLLISION_POOL":
        return buildPool(ctx);
      case "GENERATING_HYPOTHESES":
        return await generateHypotheses(ctx, ports);
      case "PLANNING_EVIDENCE":
        return planStep(ctx);
      case "COLLECTING_EVIDENCE":
        return await collect(ctx, ports);
      case "EVALUATING_EVIDENCE":
        return await evaluate(ctx, ports);
      case "REVISING_HYPOTHESES":
        return await revise(ctx, ports);
      default:
        // COUNTERFACTUAL, COMPOSITION, and REVALIDATION handlers arrive in M7/M8.
        return fatal(
          "STATE_NOT_IMPLEMENTED",
          `No handler for ${ctx.run.state}`,
        );
    }
  } catch (error) {
    if (error instanceof Cancelled)
      return { ...base("CANCEL"), terminalReason: "USER_CANCELLED" };
    throw error;
  }
}

/** Which resources a state consumes (runner budget pre-check, AGENT_WORKFLOW §7). */
export function stateNeeds(state: RunState): { llm: boolean; qloo: boolean } {
  return {
    llm: [
      "ANALYZING_INTENT",
      "GENERATING_HYPOTHESES",
      "EVALUATING_EVIDENCE",
      "REVISING_HYPOTHESES",
    ].includes(state),
    qloo: ["RESOLVING_ENTITIES", "DISCOVERING"].includes(state),
  };
}
