import type {
  QlooEntityItem,
  QlooProvenanceLike,
  QlooResult,
  QlooTagItem,
  ResolutionCandidatesLike,
} from "../ports";
import {
  INSIGHT,
  LEGACY,
  base,
  domainFromType,
  provenanceOf,
  qctx,
  qlooCall,
  qlooFailure,
  truncate,
} from "./common";
import type {
  CommitPlan,
  EntityRef,
  Ports,
  StepContext,
  StepResult,
} from "./types";

/**
 * R2 resolution (AGENT_WORKFLOW §8.1, §11 H2) on the V1-observed contract (ADR-019):
 * - typed interests: `describe(entity, type)`; `api search` only when describe finds nothing
 *   or asks for input (V1: search is the only plain search and adds disambiguation);
 * - untyped interests: `describe(entity)` plus `find_tags` — an interest may be a tag
 *   ("city pop"), and one concept maps to several tags (V1 finding 5);
 * - the venue locality: `describe(…, locality)`, then `api search --type locality` for the
 *   disambiguation strings `describe` omits (V1 finding 3).
 * The exact-single rule auto-accepts only one candidate whose name equals the input; the
 * harness "exact" pick alone is never trusted (V1 finding 1).
 */

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function mergeCandidates(input: {
  describe?: ResolutionCandidatesLike | null;
  search?: QlooEntityItem[];
  tags?: QlooTagItem[];
}): ResolutionCandidatesLike {
  const entities: ResolutionCandidatesLike["entities"] = [];
  const seen = new Map<string, number>();
  for (const c of input.describe?.entities ?? []) {
    if (seen.has(c.qlooId)) continue;
    seen.set(c.qlooId, entities.length);
    entities.push({ ...c });
  }
  (input.search ?? []).forEach((item, rank) => {
    const at = seen.get(item.qlooId);
    if (at !== undefined) {
      // Search contributes the disambiguation and description describe omits.
      const existing = entities[at]!;
      entities[at] = {
        ...existing,
        type: existing.type ?? item.type,
        disambiguation: existing.disambiguation ?? item.disambiguation,
        description: existing.description ?? item.description,
        popularity: existing.popularity ?? item.popularity,
      };
      return;
    }
    seen.set(item.qlooId, entities.length);
    entities.push({
      qlooId: item.qlooId,
      name: item.name,
      type: item.type,
      popularity: item.popularity,
      description: item.description,
      disambiguation: item.disambiguation,
      legacyType: LEGACY.has(domainFromType(item.type) ?? ""),
      source: "search",
      rankInSource: rank,
    });
  });
  const tags = [...(input.describe?.tags ?? [])];
  (input.tags ?? []).forEach((t, rank) => {
    if (tags.some((x) => x.tagId === t.tagId)) return;
    tags.push({
      tagId: t.tagId,
      name: t.name,
      tagType: t.tagType,
      popularity: t.popularity,
      rankInSource: rank,
    });
  });
  return {
    entities,
    tags,
    ...(input.describe?.harnessSelectedQlooId
      ? { harnessSelectedQlooId: input.describe.harnessSelectedQlooId }
      : {}),
    provenance: input.describe?.provenance ?? [],
  };
}

/** CI-2 / CI-A1: accept only a single candidate whose name is exactly the user's text. */
export function exactSingle(
  candidates: ResolutionCandidatesLike,
  inputText: string,
):
  | { kind: "entity"; candidate: ResolutionCandidatesLike["entities"][number] }
  | { kind: "tag"; candidate: ResolutionCandidatesLike["tags"][number] }
  | null {
  if (candidates.entities.length + candidates.tags.length !== 1) return null;
  const wanted = normalize(inputText);
  const entity = candidates.entities[0];
  if (entity)
    return normalize(entity.name) === wanted
      ? { kind: "entity", candidate: entity }
      : null;
  const tag = candidates.tags[0]!;
  return normalize(tag.name) === wanted
    ? { kind: "tag", candidate: tag }
    : null;
}

interface Row {
  index: number;
  text: string;
  hint: string | null;
  kind: "entity" | "locality";
}

function rowsFor(ctx: StepContext): Row[] {
  const interests = ctx.brief.content.interests;
  const rows: Row[] = interests.map((interest, i) => {
    const latest = ctx.resolutions.find((r) => r.interestIndex === i);
    const guessed = ctx.brief.intentFrame?.interests[i]?.guessedDomain;
    const hint =
      latest?.domainHint ??
      interest.domainHint ??
      (guessed && guessed !== "unknown" ? guessed : null);
    return {
      index: i,
      text: latest?.inputText ?? interest.text,
      hint,
      kind: "entity",
    };
  });
  const locality = ctx.brief.content.venue.localityText;
  if (locality) {
    const latest = ctx.resolutions.find(
      (r) => r.interestIndex === interests.length,
    );
    rows.push({
      index: interests.length,
      text: latest?.inputText ?? locality,
      hint: "locality",
      kind: "locality",
    });
  }
  return rows;
}

export async function resolveEntities(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("RESOLUTION_COMPLETE");
  const statuses: string[] = [];
  const resolutions: NonNullable<CommitPlan["resolutions"]> = [];
  const entities: NonNullable<CommitPlan["entities"]> = [];
  const needInput: number[] = [];

  for (const row of rowsFor(ctx)) {
    const latest = ctx.resolutions.find((r) => r.interestIndex === row.index);
    if (latest && latest.status !== "PENDING") {
      statuses.push(latest.status);
      if (latest.status === "AMBIGUOUS" || latest.status === "UNRESOLVED")
        needInput.push(row.index);
      continue;
    }
    const purpose = `resolve:${row.kind}:${row.index}`;
    const label = `"${truncate(row.text, 40)}"`;
    const invocations: string[] = [];
    let origin: QlooProvenanceLike | null = null;
    const record = <T>(result: QlooResult<T>) => {
      if ("provenance" in result && result.provenance?.toolInvocationId) {
        invocations.push(result.provenance.toolInvocationId);
        origin ??= result.provenance;
      }
      return result;
    };
    const typed =
      row.hint &&
      (INSIGHT.has(row.hint) ||
        LEGACY.has(row.hint) ||
        row.hint === "locality");

    const described = record(
      await qlooCall(
        ctx,
        acc,
        "describeEntity",
        () =>
          ports.qloo.describeEntity(
            {
              entity: row.text,
              ...(typed ? { type: row.hint as "book" } : {}),
            },
            qctx(ctx, purpose),
          ),
        label,
      ),
    );
    let failed = qlooFailure(described);
    if (failed) return { ...failed, events: acc.events, usage: acc.usage };
    const fromDescribe =
      described.kind === "OK"
        ? (described.resolution ?? null)
        : described.kind === "NEEDS_INPUT"
          ? described.resolution
          : null;

    let search: QlooEntityItem[] = [];
    const needsSearch =
      row.kind === "locality"
        ? described.kind !== "OK" || (fromDescribe?.entities.length ?? 0) > 1
        : typed && described.kind !== "OK";
    if (needsSearch) {
      const found = record(
        await qlooCall(
          ctx,
          acc,
          "searchEntities",
          () =>
            ports.qloo.searchEntities(
              {
                query: row.text,
                ...(typed ? { type: row.hint as "book" } : {}),
                take: 5,
              },
              qctx(ctx, purpose),
            ),
          label,
        ),
      );
      failed = qlooFailure(found);
      if (failed) return { ...failed, events: acc.events, usage: acc.usage };
      if (found.kind === "OK") search = found.items;
    }

    let tags: QlooTagItem[] = [];
    if (!typed) {
      const found = record(
        await qlooCall(
          ctx,
          acc,
          "findTags",
          () =>
            ports.qloo.findTags(
              { query: row.text, limit: 5 },
              qctx(ctx, purpose),
            ),
          label,
        ),
      );
      failed = qlooFailure(found);
      if (failed) return { ...failed, events: acc.events, usage: acc.usage };
      if (found.kind === "OK") tags = found.items;
    }

    const candidates = mergeCandidates({
      describe: fromDescribe,
      search,
      tags,
    });
    const accepted = exactSingle(candidates, row.text);
    let selected: EntityRef | null = null;
    let status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED" =
      candidates.entities.length + candidates.tags.length > 1
        ? "AMBIGUOUS"
        : "UNRESOLVED";
    if (accepted && invocations.length > 0) {
      const provenanceClass = provenanceOf(origin);
      if (accepted.kind === "entity") {
        const c = accepted.candidate;
        const domain = domainFromType(c.type);
        const kind = domain === "locality" ? "locality" : "entity";
        const item =
          described.kind === "OK"
            ? described.items.find((e) => e.qlooId === c.qlooId)
            : undefined;
        entities.push({
          kind,
          qlooId: c.qlooId,
          name: c.name,
          qlooType: c.type ?? null,
          domain,
          disambiguation: c.disambiguation ?? null,
          legacyType: c.legacyType,
          snapshot: {
            popularity: c.popularity ?? null,
            description: c.description ?? item?.description ?? null,
            source: c.source,
            missingFields: item?.missingFields ?? [],
          },
          sourceToolInvocationId: invocations[0]!,
          provenanceClass,
        });
        selected = { kind, qlooId: c.qlooId };
      } else {
        const t = accepted.candidate;
        entities.push({
          kind: "tag",
          qlooId: t.tagId,
          name: t.name,
          qlooType: t.tagType ?? null,
          domain: "tag",
          snapshot: {
            popularity: t.popularity ?? null,
            tagType: t.tagType ?? null,
          },
          sourceToolInvocationId: invocations[0]!,
          provenanceClass,
        });
        selected = { kind: "tag", qlooId: t.tagId };
      }
      status = "RESOLVED";
    }
    if (status !== "RESOLVED") needInput.push(row.index);
    statuses.push(status);
    resolutions.push({
      existingId: latest?.id ?? null,
      interestIndex: row.index,
      inputText: row.text,
      domainHint: row.hint,
      requestedKind: row.kind,
      candidates,
      toolInvocationIds: invocations,
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
        `${statuses.length - needInput.length} of ${statuses.length} items resolved exactly; ${needInput.length} need your choice`,
      ),
    });
  } else {
    acc.events.push({
      type: "DECISION_SUMMARY",
      role: "R2",
      summary: truncate(
        `All ${statuses.length} items resolved exactly or excluded`,
      ),
    });
  }
  return acc;
}
