import { z } from "zod";
import {
  DataOrigin,
  EnvelopeShape,
  EnvelopeStatus,
  QlooMeasure,
  QlooTransport,
} from "../enums";

// Qloo identifiers are stored exactly as returned (entity UUIDs, tag/type URNs).
export const QlooId = z.string().min(1).max(200);
export const QlooTypeUrn = z.string().regex(/^urn:[a-z_]+(?::[a-z0-9_]+)*$/);

/**
 * One candidate the user can choose at gate H2. V1 showed that harness "exact" matches can
 * select a minor edition while the canonical entity is only an alternative, so every
 * candidate keeps its type, popularity, description, and disambiguation text.
 */
export const ResolutionCandidate = z.object({
  qlooId: QlooId,
  name: z.string().min(1),
  type: QlooTypeUrn.optional(),
  popularity: z.number().min(0).max(1).optional(),
  description: z.string().optional(),
  disambiguation: z.string().optional(),
  legacyType: z.boolean().default(false),
  // Where the candidate came from: the harness's selected pick, one of its alternatives,
  // an ambiguity issue (needs_input), or a /search result used for disambiguation.
  source: z.enum(["selected", "alternative", "issue_candidate", "search"]),
  rankInSource: z.number().int().min(0),
});
export type ResolutionCandidate = z.infer<typeof ResolutionCandidate>;

export const TagCandidate = z.object({
  tagId: QlooId,
  name: z.string().min(1),
  tagType: QlooTypeUrn.optional(),
  popularity: z.number().min(0).max(1).optional(),
  rankInSource: z.number().int().min(0),
});
export type TagCandidate = z.infer<typeof TagCandidate>;

// Harness resolution provenance (V1: provider, strategy, endpoint, match).
export const ResolutionProvenance = z.object({
  providerId: z.string().optional(),
  strategy: z.string().optional(),
  endpoint: z.string().optional(),
  match: z.string().optional(), // e.g. "exact", "identifier"
  issueKind: z.string().optional(), // e.g. "ambiguous"
  usesModel: z.boolean().optional(),
});
export type ResolutionProvenance = z.infer<typeof ResolutionProvenance>;

export const ResolutionCandidates = z.object({
  entities: z.array(ResolutionCandidate).default([]),
  tags: z.array(TagCandidate).default([]),
  harnessSelectedQlooId: QlooId.optional(), // the harness pick; never auto-accepted on its own
  provenance: z.array(ResolutionProvenance).default([]),
});
export type ResolutionCandidates = z.infer<typeof ResolutionCandidates>;

/** A Qloo request as recorded by the harness (provenance.requests[]). */
export const HarnessRequestRecord = z.object({
  method: z.literal("GET"),
  path: z.string().min(1),
  query: z.record(z.string(), z.unknown()).default({}),
});

export const QlooProvenance = z.object({
  toolInvocationId: z.string(),
  snapshotId: z.string().nullable(),
  transport: QlooTransport,
  workflow: z.string().min(1),
  harnessVersion: z.string().min(1),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  dataOrigin: DataOrigin,
  retrievedAt: z.string(),
  correlationId: z.string().optional(),
  endpoint: z.string().optional(),
  requests: z.array(HarnessRequestRecord).default([]),
});
export type QlooProvenance = z.infer<typeof QlooProvenance>;

/** Structural summary of a harness response; stored even when raw retention is off. */
export const EnvelopeSummary = z.object({
  status: EnvelopeStatus,
  shape: EnvelopeShape,
  resultCount: z.number().int().min(0).nullable(),
  errorCode: z.string().nullable(),
  retryable: z.boolean().nullable(),
});
export type EnvelopeSummary = z.infer<typeof EnvelopeSummary>;

/**
 * One verifiable fact extracted from a Qloo response. `measure` states what the number
 * means; Qloo values are aggregate audience signals, never creative-fit scores.
 */
export const EvidenceFact = z.object({
  statement: z.string().min(1).max(400),
  jsonPointer: z.string().regex(/^(\/[^/]*)*$/),
  value: z.unknown(),
  measure: QlooMeasure,
  // True when the pointer was verified against the response before it was discarded
  // (raw retention off), or when it can be re-verified against a retained snapshot.
  verifiedAtIngest: z.boolean(),
});
export type EvidenceFact = z.infer<typeof EvidenceFact>;
