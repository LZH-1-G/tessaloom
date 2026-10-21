import {
  buildCollisionCandidates,
  selectPool,
  type ThreadItem,
} from "@tessaloom/core";
import type { QlooProvenanceLike, QlooResult, QlooTagItem } from "../ports";
import {
  INSIGHT,
  base,
  domainFromType,
  fatal,
  provenanceOf,
  qctx,
  qlooCall,
  qlooFailure,
  remainingNow,
  truncate,
} from "./common";
import type {
  CommitPlan,
  EntityRef,
  EntityView,
  Ports,
  StepContext,
  StepResult,
} from "./types";

/** Threads keep the top k per (seed, domain); tags enrich at most this many items. */
export const THREAD_K = 10;
export const MAX_TAG_ENRICHMENT = 8;

function rawAt(
  raw: unknown,
  position: number,
  qlooId: string,
  field: string,
): unknown {
  const results = (raw as { results?: Record<string, unknown>[] } | null)
    ?.results;
  const row = Array.isArray(results) ? results[position] : undefined;
  return row && (row.entity_id === qlooId || row.id === qlooId)
    ? row[field]
    : undefined;
}

/** HAS_TAG records for one entity from an `entity_tags` result (V1: `{id,name,type,…}`). */
function tagRecords(
  owner: EntityRef,
  result: Extract<QlooResult<QlooTagItem>, { kind: "OK" }>,
  commit: {
    entities: NonNullable<CommitPlan["entities"]>;
    relations: NonNullable<CommitPlan["relations"]>;
  },
) {
  const prov = result.provenance;
  if (!prov.toolInvocationId) return 0;
  result.items.forEach((tag, position) => {
    commit.entities.push({
      kind: "tag",
      qlooId: tag.tagId,
      name: tag.name,
      qlooType: tag.tagType ?? null,
      domain: "tag",
      snapshot: {
        tagType: tag.tagType ?? null,
        popularity: tag.popularity ?? null,
      },
      sourceToolInvocationId: prov.toolInvocationId,
      provenanceClass: provenanceOf(prov),
    });
    const affinity = typeof tag.affinity === "number" ? tag.affinity : null;
    const raw = (result.raw as { results?: Record<string, unknown>[] } | null)
      ?.results?.[position];
    commit.relations.push({
      from: owner,
      to: { kind: "tag", qlooId: tag.tagId },
      kind: "HAS_TAG",
      provenanceClass: provenanceOf(prov),
      toolInvocationIds: [prov.toolInvocationId!],
      facts:
        affinity === null
          ? []
          : [
              {
                statement: `Tag "${truncate(tag.name, 60)}" with aggregate affinity ${affinity}`,
                jsonPointer: `/results/${position}/affinity`,
                value: affinity,
                measure: "TAG_ASSOCIATION",
                verifiedAtIngest: raw?.affinity === affinity,
              },
            ],
      weight: affinity,
    });
  });
  return result.items.length;
}

export async function discover(
  ctx: StepContext,
  ports: Ports,
): Promise<StepResult> {
  const acc = base("DISCOVERY_DONE");
  const interestCount = ctx.brief.content.interests.length;
  let seeds = ctx.seeds;
  let location = ctx.location;
  if (seeds.length === 0) {
    const resolved = (index: (i: number) => boolean) =>
      ctx.resolutions
        .filter(
          (r) =>
            index(r.interestIndex) &&
            r.status === "RESOLVED" &&
            r.selectedEntityId,
        )
        .map((r) => ctx.entities.get(r.selectedEntityId!))
        .filter((e): e is EntityView => !!e);
    seeds = resolved((i) => i < interestCount).filter(
      (e) => e.kind !== "locality",
    );
    location =
      resolved((i) => i === interestCount).find((e) => e.kind === "locality") ??
      null;
    acc.commit.seeds = [
      ...seeds.map((s) => ({ ref: s.id, role: "seed" as const })),
      ...(location ? [{ ref: location.id, role: "location" as const }] : []),
    ];
  }
  const commit = {
    entities: [] as NonNullable<CommitPlan["entities"]>,
    relations: [] as NonNullable<CommitPlan["relations"]>,
  };
  const budget = () => remainingNow(ctx, acc).qlooCalls;
  // Half of the run's Qloo budget stays reserved for evidence (AGENT_WORKFLOW §7).
  const reserve = Math.ceil(ctx.run.budget.maxQlooCalls / 2);
  const fail = (failed: StepResult) => ({
    ...failed,
    events: acc.events,
    usage: acc.usage,
  });

  // 1. Seed tags (CI-5): one entity_tags call per entity seed; tag seeds are their own tag.
  const tagsOf = new Map<string, string[]>();
  for (const seed of seeds.filter((s) => s.kind === "entity")) {
    if (budget() <= reserve) break;
    const result = await qlooCall(
      ctx,
      acc,
      "entityTags",
      () =>
        ports.qloo.entityTags(
          { entities: [seed.qlooId], limit: 10 },
          qctx(ctx, `tags:${seed.id}`),
        ),
      `tags of "${truncate(seed.name, 40)}"`,
    );
    const failed = qlooFailure(result);
    if (failed) return fail(failed);
    if (result.kind === "OK") {
      tagRecords(seed.id, result, commit);
      tagsOf.set(
        seed.qlooId,
        result.items.map((t) => t.tagId),
      );
    }
  }

  // 2. Threads (§16 step 1): each seed into every other target domain.
  const targets = ctx.experiment.variables.targetDomains.filter((d) =>
    INSIGHT.has(d),
  );
  const calls = seeds.flatMap((s) =>
    targets.filter((t) => t !== s.domain).map((t) => ({ seed: s, target: t })),
  );
  let ok = 0;
  const items = new Map<
    string,
    {
      qlooId: string;
      seeds: Set<string>;
      best: number;
      prov: QlooProvenanceLike;
    }
  >();
  for (const { seed, target } of calls) {
    if (budget() <= 0) break;
    const input =
      seed.kind === "tag"
        ? {
            targetType: target as "book",
            signalTags: [seed.qlooId],
            limit: THREAD_K,
          }
        : {
            targetType: target as "book",
            signals: [seed.qlooId],
            limit: THREAD_K,
          };
    const result = await qlooCall(
      ctx,
      acc,
      "recommend",
      () =>
        ports.qloo.recommend(input, qctx(ctx, `discover:${seed.id}:${target}`)),
      `${target} for "${truncate(seed.name, 40)}"`,
    );
    const failed = qlooFailure(result);
    if (failed) return fail(failed);
    if (result.kind !== "OK" || !result.provenance.toolInvocationId) continue;
    ok++;
    const prov = result.provenance;
    result.items.forEach((item, position) => {
      if (item.qlooId === seed.qlooId) return;
      // Another seed in this thread: link to it, never overwrite the resolved seed record.
      const seedHit = seeds.find((s) => s.qlooId === item.qlooId);
      if (!seedHit)
        commit.entities.push({
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
      const affinity = item.affinity;
      commit.relations.push({
        from: seed.id,
        to: seedHit ? seedHit.id : { kind: "entity", qlooId: item.qlooId },
        kind: "THREAD",
        provenanceClass: provenanceOf(prov),
        toolInvocationIds: [prov.toolInvocationId!],
        facts:
          typeof affinity === "number"
            ? [
                {
                  statement: `Rank ${position + 1} of ${result.items.length} ${target} results for audiences of ${truncate(seed.name, 60)} (aggregate affinity)`,
                  jsonPointer: `/results/${position}/affinity`,
                  value: affinity,
                  measure: "AUDIENCE_AFFINITY",
                  verifiedAtIngest:
                    rawAt(result.raw, position, item.qlooId, "affinity") ===
                    affinity,
                },
              ]
            : [],
        weight: Number((1 - position / THREAD_K).toFixed(4)),
      });
      if (!seedHit) {
        const entry = items.get(item.qlooId) ?? {
          qlooId: item.qlooId,
          seeds: new Set<string>(),
          best: position,
          prov,
        };
        entry.seeds.add(seed.id);
        entry.best = Math.min(entry.best, position);
        items.set(item.qlooId, entry);
      }
    });
  }

  // 3. Tag enrichment (CI-5): per-entity entity_tags calls (V1: a multi-entity call merges
  // tags without attribution). Items that bridge several seeds come first, then by rank.
  const ranked = [...items.values()].sort(
    (a, b) =>
      b.seeds.size - a.seeds.size ||
      a.best - b.best ||
      (a.qlooId < b.qlooId ? -1 : 1),
  );
  let enriched = 0;
  for (const item of ranked) {
    if (enriched >= MAX_TAG_ENRICHMENT || budget() <= reserve) break;
    const result = await qlooCall(
      ctx,
      acc,
      "entityTags",
      () =>
        ports.qloo.entityTags(
          { entities: [item.qlooId], limit: 10 },
          qctx(ctx, `tags:${item.qlooId}`),
        ),
      `tags of a thread item`,
    );
    const failed = qlooFailure(result);
    if (failed) return fail(failed);
    enriched++;
    if (result.kind === "OK")
      tagRecords({ kind: "entity", qlooId: item.qlooId }, result, commit);
  }

  acc.commit.entities = commit.entities;
  acc.commit.relations = commit.relations;
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
      `Expanded ${seeds.length} seed${seeds.length === 1 ? "" : "s"} into ${targets.length} domains: ${ok} of ${calls.length} thread queries returned data; tags fetched for ${enriched} thread items${location ? `; venue locality ${location.name}` : ""}`,
    ),
  });
  return acc;
}

/** §16 steps 2–4 on the shared engine; every candidate is stored for the tension slider. */
export function buildPool(ctx: StepContext): StepResult {
  const acc = base("POOL_READY");
  const threads = new Map<string, ThreadItem[]>();
  for (const t of ctx.threads) {
    const e = ctx.entities.get(t.entityId);
    if (!e?.domain) continue;
    const list = threads.get(t.seedId) ?? [];
    list.push({ entityId: t.entityId, domain: e.domain, position: t.position });
    threads.set(t.seedId, list);
  }
  const candidates = buildCollisionCandidates({
    seeds: ctx.seeds
      .filter((s) => s.domain)
      .map((s) => ({ entityId: s.id, domain: s.domain! })),
    threads,
    tags: ctx.tags,
    k: THREAD_K,
  });
  const tension = ctx.experiment.variables.collisionTension;
  const selection = new Map(
    selectPool(candidates, tension).map((s) => [s.key, s]),
  );
  acc.commit.collisionCandidates = candidates.map((c) => {
    const s = selection.get(c.key);
    return {
      elementEntityIds: c.elementEntityIds,
      relevance: c.relevance,
      novelty: c.novelty,
      tensionFit: Number((1 - Math.abs(c.novelty - tension)).toFixed(4)),
      noveltyInputs: c.noveltyInputs,
      selected: !!s,
      rank: s?.rank ?? null,
    };
  });
  acc.guard = { poolSize: selection.size };
  const reduced = candidates.filter(
    (c) => c.noveltyInputs === "REDUCED_INPUTS",
  ).length;
  acc.events.push({
    type: "DECISION_SUMMARY",
    role: null,
    summary: truncate(
      `Collision pool: ${selection.size} of ${candidates.length} bridges selected at tension ${tension}; ${reduced} scored without tags (reduced inputs)`,
    ),
    payload: {
      selected: selection.size,
      candidates: candidates.length,
      reducedInputs: reduced,
      tension,
    },
  });
  if (selection.size < 3)
    return {
      ...fatal("POOL_TOO_SMALL", "Fewer than 3 collision candidates"),
      events: acc.events,
    };
  acc.pendingConfirmation = { kind: "POOL", tension };
  return acc;
}
