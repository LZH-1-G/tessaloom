import type {
  EnvelopeShape,
  EnvelopeStatus,
  EnvelopeSummary,
  ResolutionCandidate,
  ResolutionCandidates,
  ResolutionProvenance,
  TagCandidate,
} from "@tessaloom/core";
import type { HarnessCall, RawHarnessResult } from "./types";

const STATUSES: EnvelopeStatus[] = [
  "ok",
  "empty",
  "needs_input",
  "partial",
  "degraded",
  "error",
];
const LEGACY_TYPES = new Set([
  "urn:entity:author",
  "urn:entity:actor",
  "urn:entity:director",
  "urn:entity:album",
]);

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
export const isLegacyType = (type?: string) =>
  type ? LEGACY_TYPES.has(type) : false;

export interface ParsedEnvelope {
  summary: EnvelopeSummary;
  summaryText?: string;
  error?: {
    code: string;
    retryable: boolean;
    recovery?: string;
    layer?: string;
  };
  correlationId?: string;
  endpoint?: string;
  requests: { method: "GET"; path: string; query: Record<string, unknown> }[];
  resolution?: ResolutionCandidates;
}

function summary(
  status: EnvelopeStatus,
  shape: EnvelopeShape,
  resultCount: number | null,
  error?: ParsedEnvelope["error"],
): EnvelopeSummary {
  return {
    status,
    shape,
    resultCount,
    errorCode: error?.code ?? null,
    retryable: error?.retryable ?? null,
  };
}

function harnessRequests(provenance: unknown): ParsedEnvelope["requests"] {
  if (!isObj(provenance) || !Array.isArray(provenance.requests)) return [];
  return provenance.requests
    .filter((r): r is Obj => isObj(r) && typeof r.path === "string")
    .map((r) => ({
      method: "GET" as const,
      path: r.path as string,
      query: isObj(r.query) ? r.query : {},
    }));
}

/** Classify any harness output (V1-observed shapes) without trusting its structure. */
export function parseEnvelope(
  call: HarnessCall,
  result: RawHarnessResult,
): ParsedEnvelope {
  const payload = result.payload;
  if (call.kind === "search") {
    if (Array.isArray(payload)) {
      return {
        summary: summary(
          payload.length ? "ok" : "empty",
          "search_array",
          payload.length,
        ),
        requests: [],
      };
    }
    if (isObj(payload) && Array.isArray(payload.results)) {
      const n = payload.results.length;
      return {
        summary: summary(n ? "ok" : "empty", "search_array", n),
        requests: [],
      };
    }
  }
  if (!isObj(payload)) {
    const error = { code: "UNKNOWN_ENVELOPE", retryable: false };
    return {
      summary: summary("error", "unknown", null, error),
      error,
      requests: [],
    };
  }

  // Bare failure object: { error, operation, correlation_id } (no status), exit 1/4 in V1.
  if (payload.status === undefined && isObj(payload.error)) {
    const error = {
      code: str(payload.error.code) ?? "UNKNOWN_ERROR",
      retryable: payload.error.retryable === true,
      recovery: str(payload.error.recovery),
      layer: str(payload.error.layer),
    };
    return {
      summary: summary("error", "error_object", null, error),
      error,
      correlationId: str(payload.correlation_id),
      requests: [],
    };
  }

  const status = STATUSES.find((s) => s === payload.status);
  const execution = isObj(payload.execution) ? payload.execution : {};
  const provenance = isObj(payload.provenance) ? payload.provenance : {};
  const base = {
    summaryText: str(payload.summary),
    correlationId: str(execution.correlation_id) ?? str(payload.correlation_id),
    endpoint: str(provenance.endpoint),
    requests: harnessRequests(provenance),
    resolution: parseResolution(payload.resolution),
  };
  if (!status) {
    const error = { code: "UNKNOWN_ENVELOPE", retryable: false };
    return {
      ...base,
      summary: summary("error", "unknown", null, error),
      error,
    };
  }
  if (status === "error") {
    const e = isObj(payload.error) ? payload.error : {};
    const error = {
      code: str(e.code) ?? "UNKNOWN_ERROR",
      retryable: e.retryable === true,
      recovery: str(e.recovery),
      layer: str(e.layer),
    };
    return {
      ...base,
      summary: summary("error", "error_object", null, error),
      error,
    };
  }
  let shape: EnvelopeShape = "result_list";
  let count: number | null = num(payload.result_count) ?? null;
  if (status === "needs_input") shape = "needs_input";
  else if (Array.isArray(payload.series)) {
    shape = "series";
    count ??= payload.series.length;
  } else if (isObj(payload.results)) shape = "compare_object";
  else if (Array.isArray(payload.results)) count ??= payload.results.length;
  return { ...base, summary: summary(status, shape, count) };
}

function candidateFrom(
  raw: unknown,
  source: ResolutionCandidate["source"],
  rank: number,
): ResolutionCandidate | null {
  if (!isObj(raw)) return null;
  const qlooId = str(raw.id) ?? str(raw.entity_id);
  const name = str(raw.name);
  if (!qlooId || !name) return null;
  const type = str(raw.type);
  return {
    qlooId,
    name,
    type: type && /^urn:[a-z_]+(?::[a-z0-9_]+)*$/.test(type) ? type : undefined,
    popularity: num(raw.popularity),
    description: str(raw.description),
    disambiguation: str(raw.disambiguation),
    legacyType: isLegacyType(type),
    source,
    rankInSource: rank,
  };
}

function provenanceFrom(
  raw: unknown,
  extra: Partial<ResolutionProvenance> = {},
): ResolutionProvenance {
  const p = isObj(raw) ? raw : {};
  return {
    providerId: str(p.provider_id),
    strategy: str(p.strategy),
    endpoint: str(p.endpoint),
    usesModel: typeof p.uses_model === "boolean" ? p.uses_model : undefined,
    ...extra,
  };
}

/**
 * Preserve every candidate the harness returned: the selected pick and its alternatives
 * (resolution.outcomes) or the ambiguity candidates (resolution.issues). V1 showed that the
 * "selected" pick can be a minor edition, so nothing here is auto-accepted.
 */
export function parseResolution(
  raw: unknown,
): ResolutionCandidates | undefined {
  if (!isObj(raw)) return undefined;
  const entities: ResolutionCandidate[] = [];
  const tags: TagCandidate[] = [];
  const provenance: ResolutionProvenance[] = [];
  let harnessSelectedQlooId: string | undefined;

  for (const outcome of Array.isArray(raw.outcomes) ? raw.outcomes : []) {
    if (!isObj(outcome)) continue;
    const selected = candidateFrom(outcome.selected, "selected", 0);
    if (selected) {
      entities.push(selected);
      harnessSelectedQlooId ??= selected.qlooId;
    }
    (Array.isArray(outcome.alternatives) ? outcome.alternatives : []).forEach(
      (alt, i) => {
        const c = candidateFrom(alt, "alternative", i);
        if (c) entities.push(c);
      },
    );
    provenance.push(
      provenanceFrom(outcome.provenance, { match: str(outcome.match) }),
    );
  }
  for (const issue of Array.isArray(raw.issues) ? raw.issues : []) {
    if (!isObj(issue)) continue;
    const isTag = issue.input_kind === "tag";
    (Array.isArray(issue.candidates) ? issue.candidates : []).forEach(
      (cand, i) => {
        if (isTag && isObj(cand) && str(cand.id) && str(cand.name)) {
          tags.push({
            tagId: str(cand.id)!,
            name: str(cand.name)!,
            tagType: str(cand.type),
            popularity: num(cand.popularity),
            rankInSource: i,
          });
        } else {
          const c = candidateFrom(cand, "issue_candidate", i);
          if (c) entities.push(c);
        }
      },
    );
    provenance.push(
      provenanceFrom(issue.provenance, { issueKind: str(issue.kind) }),
    );
  }
  if (!entities.length && !tags.length && !provenance.length) return undefined;
  return { entities, tags, harnessSelectedQlooId, provenance };
}
