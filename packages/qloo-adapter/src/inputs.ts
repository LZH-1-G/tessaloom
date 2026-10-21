import { z } from "zod";
import type { HarnessCall } from "./types";

// Bounds and field names are taken from the V1-observed tool schemas (API_CONTRACTS §5.5.3).
const InsightType = z.enum([
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
const ResolvableType = z.enum([
  ...InsightType.options,
  "locality",
  "actor",
  "album",
  "author",
  "director",
]);
const Ref = z.string().trim().min(1).max(200);
const Refs = (max: number) => z.array(Ref).min(1).max(max);
const Limit = z.number().int().min(1).max(20);
const Operator = z.enum(["union", "intersection"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SearchEntitiesInput = z.object({
  query: z.string().trim().min(1).max(120),
  // Alias or URN accepted by `qloo api search --type`.
  type: z
    .union([ResolvableType, z.string().regex(/^urn:entity:[a-z_]+$/)])
    .optional(),
  take: z.number().int().min(1).max(20).default(5),
});
export const DescribeEntityInput = z.object({
  entity: Ref,
  type: ResolvableType.optional(),
});
export const FindTagsInput = z.object({
  query: z.string().trim().min(1).max(120),
  semantic: z.boolean().optional(),
  limit: Limit.default(10),
});
export const EntityTagsInput = z.object({
  entities: Refs(10),
  entityType: ResolvableType.optional(),
  limit: Limit.default(10),
});
export const RecommendInput = z
  .object({
    targetType: InsightType,
    signals: Refs(10).optional(),
    signalTags: Refs(10).optional(),
    signalTagsOperator: Operator.optional(),
    signalLocation: Ref.optional(),
    demographic: Ref.optional(),
    filterLocation: Ref.optional(),
    includeTags: Refs(10).optional(),
    includeTagsOperator: Operator.optional(),
    excludeTags: Refs(10).optional(),
    excludeTagsOperator: Operator.optional(),
    explain: z.boolean().default(true),
    limit: Limit.default(10),
  })
  .refine(
    (v) => v.signals || v.signalTags || v.signalLocation || v.demographic,
    "recommend needs at least one signal",
  );
export const RankInput = z.object({
  options: Refs(10),
  optionType: InsightType,
  signals: Refs(10).optional(),
  signalLocation: Ref.optional(),
  demographic: Ref.optional(),
  includeTags: Refs(10).optional(),
  excludeTags: Refs(10).optional(),
});
export const CompareAudiencesInput = z.object({
  groupA: Refs(10),
  groupB: Refs(10),
  targetType: InsightType.optional(),
  limit: Limit.optional(),
});
export const AudienceDemographicsInput = z.object({
  entity: Ref,
  entityType: ResolvableType.optional(),
  limit: Limit.optional(),
});
export const WherePopularInput = z.object({
  entity: Ref,
  entityType: ResolvableType.optional(),
  within: Ref,
  limit: Limit.default(10),
});
export const TrendsInput = z
  .object({
    entities: Refs(5),
    entityType: InsightType,
    startDate: IsoDate,
    endDate: IsoDate,
    limit: Limit.optional(),
  })
  .refine(
    (v) => v.startDate <= v.endDate,
    "startDate must not be after endDate",
  );

type Out<S extends z.ZodType> = z.output<S>;

/** Drop undefined members so the canonical request hash never depends on absent options. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined),
  );
}

export const toHarness = {
  searchEntities: (i: Out<typeof SearchEntitiesInput>): HarnessCall => ({
    kind: "search",
    args: compact({
      query: i.query,
      type: i.type,
      take: i.take,
    }) as HarnessCall["args"] & {
      query: string;
      take: number;
    },
  }),
  describeEntity: (i: Out<typeof DescribeEntityInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "describe",
    args: compact({ entity: i.entity, type: i.type }),
  }),
  findTags: (i: Out<typeof FindTagsInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "find_tags",
    args: compact({ query: i.query, semantic: i.semantic, limit: i.limit }),
  }),
  entityTags: (i: Out<typeof EntityTagsInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "entity_tags",
    args: compact({
      entities: i.entities,
      entity_type: i.entityType,
      limit: i.limit,
    }),
  }),
  recommend: (i: Out<typeof RecommendInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "recommend",
    args: compact({
      target_type: i.targetType,
      signals: i.signals,
      signal_tags: i.signalTags,
      signal_tags_operator: i.signalTagsOperator,
      signal_location: i.signalLocation,
      demographic: i.demographic,
      filter_location: i.filterLocation,
      include_tags: i.includeTags,
      include_tags_operator: i.includeTagsOperator,
      exclude_tags: i.excludeTags,
      exclude_tags_operator: i.excludeTagsOperator,
      explain: i.explain,
      limit: i.limit,
    }),
  }),
  rank: (i: Out<typeof RankInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "rank",
    args: compact({
      options: i.options,
      option_type: i.optionType,
      signals: i.signals,
      signal_location: i.signalLocation,
      demographic: i.demographic,
      include_tags: i.includeTags,
      exclude_tags: i.excludeTags,
    }),
  }),
  compareAudiences: (i: Out<typeof CompareAudiencesInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "compare_audiences",
    args: compact({
      group_a: i.groupA,
      group_b: i.groupB,
      target_type: i.targetType,
      limit: i.limit,
    }),
  }),
  audienceDemographics: (
    i: Out<typeof AudienceDemographicsInput>,
  ): HarnessCall => ({
    kind: "workflow",
    workflow: "audience_demographics",
    args: compact({
      entity: i.entity,
      entity_type: i.entityType,
      limit: i.limit,
    }),
  }),
  wherePopular: (i: Out<typeof WherePopularInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "where_popular",
    args: compact({
      entity: i.entity,
      entity_type: i.entityType,
      within: i.within,
      limit: i.limit,
    }),
  }),
  trends: (i: Out<typeof TrendsInput>): HarnessCall => ({
    kind: "workflow",
    workflow: "trends",
    args: compact({
      entities: i.entities,
      entity_type: i.entityType,
      start_date: i.startDate,
      end_date: i.endDate,
      limit: i.limit,
    }),
  }),
};

/**
 * Capability/type combinations observed to be rejected upstream in V1. The adapter answers
 * these locally (UNSUPPORTED) instead of spending quota on a known QLOO_CONTRACT error.
 */
export const KNOWN_UNSUPPORTED: {
  workflow: string;
  when: (args: Record<string, unknown>) => boolean;
  reason: string;
  evidence: string;
}[] = [
  {
    workflow: "trends",
    when: (args) => args.entity_type === "book",
    reason: "Trends are not available for books on the hackathon endpoint",
    evidence: "V1 LC-9 and LC-9c returned QLOO_CONTRACT (2026-10-21)",
  },
];
