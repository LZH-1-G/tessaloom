import { and, desc, eq, inArray } from "drizzle-orm";
import {
  ConfirmationResponse,
  DEFAULT_BUDGETS,
  DEFAULT_SCORING_WEIGHTS,
  ExperimentVariables,
  IllegalTransition,
  ResolutionCandidates,
  RunBudget,
  RunConfig,
  canonicalHash,
  isPaused,
  isRunnable,
  isTerminal,
  nextState,
  selectPool,
  type GuardContext,
  type RunEventName,
  type RunState,
} from "@tessaloom/core";
import { withPgTx, type DbHandle, type Executor, type Tx } from "./client";
import { DomainRuleError, NotFoundError, StateConflictError } from "./errors";
import { enqueueRunStep, type PgBoss } from "./queue";
import {
  appendRunEvents,
  createOrGetExperiment,
  createRun,
  requestRunCancel,
  setExperimentStatus,
  transitionRun,
  type NewRunEvent,
} from "./repositories/experiment";
import {
  latestResolutions,
  lockRun,
  updateCollisionCandidate,
  updateHypothesis,
} from "./repositories/orchestrator";
import { getToolInvocation } from "./repositories/qloo";
import {
  createResolution,
  excludeResolution,
  selectResolutionCandidate,
  upsertCulturalEntity,
} from "./repositories/resolution";
import {
  confirmBriefVersion,
  getBriefVersion,
  getProject,
} from "./repositories/workspace";
import {
  agentRuns,
  collisionCandidates,
  culturalEntities,
  experiments,
  hypotheses,
  projects,
} from "./schema";

/** Run-starting and human-gate services shared by the web API (AGENT_WORKFLOW §6, §9, §11). */

export const DEFAULT_TARGET_DOMAINS = [
  "artist",
  "book",
  "movie",
  "place",
] as const;

type RunRow = typeof agentRuns.$inferSelect;

export function runView(run: RunRow) {
  return {
    id: run.id,
    experimentId: run.experimentId,
    kind: run.kind,
    state: run.state,
    stateVersion: run.stateVersion,
    iteration: run.iteration,
    budget: run.budget,
    usage: run.usage,
    pendingConfirmation: run.pendingConfirmation,
    terminalReason: run.terminalReason,
    cancelRequested: run.cancelRequestedAt !== null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
export type RunView = ReturnType<typeof runView>;

function experimentStatusFor(state: RunState) {
  if (isTerminal(state))
    return state as
      "COMPLETED" | "COMPLETED_WITH_LIMITS" | "FAILED" | "CANCELLED";
  return isPaused(state) ? "PAUSED" : "RUNNING";
}

/** A run is visible only to the workspace that owns its project (SECURITY §4.2). */
export async function getRunForWorkspace(
  db: Executor,
  workspaceId: string,
  runId: string,
) {
  const [row] = await db
    .select({ run: agentRuns, experiment: experiments })
    .from(agentRuns)
    .innerJoin(experiments, eq(experiments.id, agentRuns.experimentId))
    .innerJoin(projects, eq(projects.id, experiments.projectId))
    .where(and(eq(agentRuns.id, runId), eq(projects.workspaceId, workspaceId)));
  if (!row) throw new NotFoundError("Run not found");
  return row;
}

// --- Start an EXPLORATION (DATABASE_SCHEMA §6 "Start experiment") ---

export async function startExploration(
  handle: DbHandle,
  boss: PgBoss,
  input: {
    workspaceId: string;
    projectId: string;
    briefVersionId: string;
    variables?: Partial<ExperimentVariables>;
    scoringWeights?: { support: number; novelty: number; feasibility: number };
    mode: "live" | "fixture";
    runConfig: RunConfig;
  },
) {
  const { db } = handle;
  await getProject(db, input.workspaceId, input.projectId);
  const brief = await getBriefVersion(db, input.briefVersionId);
  if (brief.projectId !== input.projectId)
    throw new NotFoundError("Brief version not found");
  const config = RunConfig.parse(input.runConfig);
  const variables = ExperimentVariables.parse({
    targetDomains: [...DEFAULT_TARGET_DOMAINS],
    ...input.variables,
  });
  const budgets = DEFAULT_BUDGETS.EXPLORATION;
  const definition = {
    schemaVersion: 1 as const,
    briefContentHash: brief.contentHash,
    seeds: [],
    variables,
    scoringWeights: input.scoringWeights ?? DEFAULT_SCORING_WEIGHTS,
    budgets,
    versions: {
      evaluationRuleset: config.evaluationRulesetVersion,
      promptSet: canonicalHash(config.promptVersions),
      qlooAdapter: config.qlooAdapterVersion,
      harness: config.harnessVersion,
      llmModel: config.llmModel,
    },
    parentExperimentKey: null,
    variableDelta: null,
  };
  return withPgTx(handle, async (tx, raw) => {
    const { experiment, reused } = await createOrGetExperiment(tx, {
      projectId: input.projectId,
      briefVersionId: input.briefVersionId,
      definition,
      mode: input.mode,
    });
    if (reused) {
      const [latest] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.experimentId, experiment.id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      if (latest)
        return {
          experimentId: experiment.id,
          experimentKey: experiment.experimentKey,
          runId: latest.id,
          reused: true,
        };
    }
    const run = await createRun(tx, {
      experimentId: experiment.id,
      kind: "EXPLORATION",
      budget: budgets,
      config,
    });
    await appendRunEvents(tx, run.id, [
      {
        type: "RUN_STARTED",
        state: "QUEUED",
        summary: "Exploration started",
        payload: { kind: "EXPLORATION", mode: input.mode },
      },
      { type: "STATE_ENTERED", state: "QUEUED", summary: "Entered QUEUED" },
    ]);
    await setExperimentStatus(tx, experiment.id, "RUNNING");
    await enqueueRunStep(boss, { runId: run.id, expectedStateVersion: 0 }, raw);
    return {
      experimentId: experiment.id,
      experimentKey: experiment.experimentKey,
      runId: run.id,
      reused: false,
    };
  });
}

// --- Shared transition helper for web-side transitions ---

async function commitTransition(
  tx: Tx,
  raw: Parameters<Parameters<typeof withPgTx>[1]>[1],
  boss: PgBoss,
  run: RunRow,
  event: RunEventName,
  guard: GuardContext,
  extra: {
    events?: NewRunEvent[];
    terminalReason?: string | null;
    clearError?: boolean;
  } = {},
) {
  let to: RunState;
  try {
    to = nextState(run.state, event, { ...guard, kind: run.kind });
  } catch (error) {
    if (error instanceof IllegalTransition) {
      if (error.reason === "GUARD_FAILED")
        throw new DomainRuleError(`Transition ${event} is not allowed yet`);
      throw new StateConflictError(
        `Run cannot accept ${event} in ${run.state}`,
      );
    }
    throw error;
  }
  const events: NewRunEvent[] = [
    ...(extra.events ?? []),
    {
      type: "STATE_ENTERED",
      state: to,
      summary: `Entered ${to}`,
      payload: { from: run.state, event },
    },
  ];
  if (isTerminal(to))
    events.push({
      type:
        to === "CANCELLED"
          ? "RUN_CANCELLED"
          : to === "FAILED"
            ? "RUN_FAILED"
            : "RUN_COMPLETED",
      state: to,
      summary:
        to === "CANCELLED"
          ? "Run cancelled — evidence incomplete"
          : `Run ${to.toLowerCase().replace(/_/g, " ")}`,
      payload: { terminalReason: extra.terminalReason ?? null },
    });
  await appendRunEvents(tx, run.id, events);
  const updated = await transitionRun(tx, {
    runId: run.id,
    expectedStateVersion: run.stateVersion,
    to,
    pendingConfirmation: null,
    ...(extra.terminalReason !== undefined
      ? { terminalReason: extra.terminalReason }
      : {}),
    ...(extra.clearError ? { error: null, terminalReason: null } : {}),
  });
  await setExperimentStatus(tx, run.experimentId, experimentStatusFor(to));
  if (isRunnable(to))
    await enqueueRunStep(
      boss,
      { runId: run.id, expectedStateVersion: updated.stateVersion },
      raw,
    );
  return updated;
}

// --- Cancellation (AGENT_WORKFLOW §9) ---

export async function cancelRun(
  handle: DbHandle,
  boss: PgBoss,
  workspaceId: string,
  runId: string,
) {
  await getRunForWorkspace(handle.db, workspaceId, runId);
  return withPgTx(handle, async (tx, raw) => {
    const run = (await lockRun(tx, runId))!;
    if (isTerminal(run.state)) return runView(run); // idempotent
    if (!run.cancelRequestedAt) {
      await requestRunCancel(tx, run.id);
      await appendRunEvents(tx, run.id, [
        {
          type: "CANCEL_REQUESTED",
          state: run.state,
          summary: "Cancellation requested",
        },
      ]);
    }
    // A paused run has no job in flight: cancel it right here.
    if (isPaused(run.state))
      return runView(
        await commitTransition(
          tx,
          raw,
          boss,
          run,
          "CANCEL",
          {},
          { terminalReason: "USER_CANCELLED" },
        ),
      );
    return runView((await lockRun(tx, runId))!);
  });
}

// --- Retry a transient failure (UI_UX_SPEC §6 "Retry step") ---

export async function retryRun(
  handle: DbHandle,
  boss: PgBoss,
  workspaceId: string,
  runId: string,
) {
  await getRunForWorkspace(handle.db, workspaceId, runId);
  return withPgTx(handle, async (tx, raw) => {
    const run = (await lockRun(tx, runId))!;
    const error = (run.error ?? {}) as {
      transient?: boolean;
      failedState?: RunState;
    };
    if (
      run.state !== "FAILED" ||
      error.transient !== true ||
      !error.failedState
    )
      throw new StateConflictError("Only a transient failure can be retried");
    return runView(
      await commitTransition(
        tx,
        raw,
        boss,
        run,
        "RETRY",
        { retryableFailure: true, retryState: error.failedState },
        {
          events: [
            {
              type: "DECISION_SUMMARY",
              state: "FAILED",
              summary: `Retrying ${error.failedState} after a transient failure`,
            },
          ],
          clearError: true,
        },
      ),
    );
  });
}

// --- Human gates (AGENT_WORKFLOW §11) ---

export async function confirmRun(
  handle: DbHandle,
  boss: PgBoss,
  workspaceId: string,
  runId: string,
  body: unknown,
) {
  const response = ConfirmationResponse.parse(body);
  const { experiment } = await getRunForWorkspace(
    handle.db,
    workspaceId,
    runId,
  );
  return withPgTx(handle, async (tx, raw) => {
    const run = (await lockRun(tx, runId))!;
    const pending = run.pendingConfirmation as { kind?: string } | null;
    if (!isPaused(run.state) || pending?.kind !== response.kind)
      throw new StateConflictError("The run is not awaiting this confirmation");
    const received: NewRunEvent = {
      type: "CONFIRMATION_RECEIVED",
      state: run.state,
      summary: `Confirmation received (${response.kind})`,
      payload: { kind: response.kind },
    };

    switch (response.kind) {
      case "BRIEF": {
        const guard = {
          confirmedBriefVersionId: response.briefVersionId,
          currentBriefVersionId: experiment.briefVersionId,
        };
        if (guard.confirmedBriefVersionId !== guard.currentBriefVersionId)
          throw new StateConflictError(
            "Confirmation references a different brief version",
          );
        await confirmBriefVersion(tx, experiment.briefVersionId);
        const brief = await getBriefVersion(tx, experiment.briefVersionId);
        const interests = (brief.content as { interests: { text: string }[] })
          .interests;
        for (const edit of response.interestDomains ?? []) {
          const interest = interests[edit.interestIndex];
          if (!interest)
            throw new DomainRuleError(`Unknown interest ${edit.interestIndex}`);
          // A PENDING record carries the user's type hint into resolution (USER_PROVIDED).
          await createResolution(tx, {
            projectId: experiment.projectId,
            briefVersionId: experiment.briefVersionId,
            runId: run.id,
            interestIndex: edit.interestIndex,
            inputText: interest.text,
            domainHint: edit.domain === "unknown" ? null : edit.domain,
            requestedKind: "entity",
          });
        }
        return runView(
          await commitTransition(
            tx,
            raw,
            boss,
            run,
            "USER_CONFIRMED_BRIEF",
            guard,
            { events: [received] },
          ),
        );
      }
      case "ENTITIES": {
        const latest = await latestResolutions(tx, experiment.briefVersionId);
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, experiment.projectId));
        let refined = false;
        for (const selection of response.selections) {
          const record = latest.find(
            (r) => r.interestIndex === selection.interestIndex,
          );
          if (!record)
            throw new DomainRuleError(
              `Unknown interest ${selection.interestIndex}`,
            );
          const choice = selection.choice;
          if (choice.type === "exclude") {
            await excludeResolution(tx, record.id);
          } else if (choice.type === "refine") {
            await createResolution(tx, {
              projectId: experiment.projectId,
              briefVersionId: experiment.briefVersionId,
              runId: run.id,
              interestIndex: selection.interestIndex,
              inputText: choice.text,
              domainHint: record.domainHint,
              requestedKind: record.requestedKind,
            });
            refined = true;
          } else {
            const candidates = ResolutionCandidates.parse(record.candidates);
            const candidate = candidates.entities.find(
              (c) => c.qlooId === choice.qlooId,
            );
            const tag = candidate
              ? undefined
              : candidates.tags.find((t) => t.tagId === choice.qlooId);
            if (!candidate && !tag)
              throw new DomainRuleError(
                "Selected entity was not among the offered candidates",
              );
            const sourceId = record.toolInvocationIds[0] ?? null;
            const source = sourceId
              ? await getToolInvocation(tx, sourceId)
              : null;
            const provenanceClass =
              source?.dataOrigin === "FIXTURE"
                ? "DEVELOPMENT_FIXTURE"
                : "QLOO_SOURCED";
            const domain = candidate
              ? (/^urn:entity:([a-z_]+)$/.exec(candidate.type ?? "")?.[1] ??
                null)
              : "tag";
            const entity = candidate
              ? await upsertCulturalEntity(tx, {
                  workspaceId: project!.workspaceId,
                  kind: domain === "locality" ? "locality" : "entity",
                  qlooId: candidate.qlooId,
                  name: candidate.name,
                  qlooType: candidate.type ?? null,
                  domain,
                  disambiguation: candidate.disambiguation ?? null,
                  legacyType: candidate.legacyType,
                  snapshot: {
                    popularity: candidate.popularity ?? null,
                    description: candidate.description ?? null,
                    source: candidate.source,
                  },
                  sourceToolInvocationId: sourceId,
                  provenanceClass,
                })
              : await upsertCulturalEntity(tx, {
                  workspaceId: project!.workspaceId,
                  kind: "tag",
                  qlooId: tag!.tagId,
                  name: tag!.name,
                  qlooType: tag!.tagType ?? null,
                  domain: "tag",
                  snapshot: {
                    popularity: tag!.popularity ?? null,
                    tagType: tag!.tagType ?? null,
                  },
                  sourceToolInvocationId: sourceId,
                  provenanceClass,
                });
            await selectResolutionCandidate(tx, {
              resolutionId: record.id,
              entityId: entity.id,
              method: "USER_SELECTED",
            });
          }
        }
        if (refined)
          return runView(
            await commitTransition(
              tx,
              raw,
              boss,
              run,
              "USER_REFINED_TERMS",
              {},
              { events: [received] },
            ),
          );
        const after = await latestResolutions(tx, experiment.briefVersionId);
        if (
          after.some(
            (r) =>
              r.status === "AMBIGUOUS" ||
              r.status === "UNRESOLVED" ||
              r.status === "PENDING",
          )
        )
          throw new DomainRuleError("Every ambiguous interest needs a choice");
        const selectedIds = after
          .filter(
            (r) =>
              r.status === "RESOLVED" &&
              r.selectedEntityId &&
              r.requestedKind !== "locality",
          )
          .map((r) => r.selectedEntityId!);
        const seedRows = selectedIds.length
          ? await tx
              .select({ domain: culturalEntities.domain })
              .from(culturalEntities)
              .where(inArray(culturalEntities.id, selectedIds))
          : [];
        return runView(
          await commitTransition(
            tx,
            raw,
            boss,
            run,
            "USER_CONFIRMED_ENTITIES",
            { seedDomains: seedRows.map((r) => r.domain ?? "unknown") },
            { events: [received] },
          ),
        );
      }
      case "POOL": {
        // Gate H2b: re-select the stored pool at the committed tension with the same engine
        // and candidate keys the browser previews with (ADR-025).
        const rows = await tx
          .select()
          .from(collisionCandidates)
          .where(eq(collisionCandidates.experimentId, experiment.id));
        const ids = [...new Set(rows.flatMap((r) => r.elementEntityIds))];
        const domains = new Map(
          (ids.length
            ? await tx
                .select({
                  id: culturalEntities.id,
                  domain: culturalEntities.domain,
                })
                .from(culturalEntities)
                .where(inArray(culturalEntities.id, ids))
            : []
          ).map((e) => [e.id, e.domain ?? "unknown"]),
        );
        const candidates = rows.map((r) => ({
          key: r.elementEntityIds.join("|"),
          elementEntityIds: [
            r.elementEntityIds[0]!,
            r.elementEntityIds[1]!,
          ] as [string, string],
          domains: [
            domains.get(r.elementEntityIds[0]!) ?? "unknown",
            domains.get(r.elementEntityIds[1]!) ?? "unknown",
          ] as [string, string],
          relevance: r.relevance,
          novelty: r.novelty,
        }));
        const selection = new Map(
          selectPool(candidates, response.tension).map((s) => [s.key, s]),
        );
        if (selection.size < 3)
          throw new DomainRuleError(
            "This tension leaves fewer than 3 collisions; choose another value.",
          );
        for (const r of rows) {
          const chosen = selection.get(r.elementEntityIds.join("|"));
          await updateCollisionCandidate(tx, r.id, {
            selected: !!chosen,
            rank: chosen?.rank ?? null,
            tensionFit: Number(
              (1 - Math.abs(r.novelty - response.tension)).toFixed(4),
            ),
          });
        }
        return runView(
          await commitTransition(
            tx,
            raw,
            boss,
            run,
            "USER_CONFIRMED_POOL",
            { poolSize: selection.size },
            {
              events: [
                {
                  ...received,
                  payload: {
                    kind: response.kind,
                    tension: response.tension,
                    selected: selection.size,
                  },
                },
              ],
            },
          ),
        );
      }
      case "HYPOTHESIS_SELECTION": {
        const ids = response.selectedHypothesisIds;
        if (ids.length > 0) {
          const rows = await tx
            .select({ id: hypotheses.id })
            .from(hypotheses)
            .where(
              and(
                eq(hypotheses.experimentId, experiment.id),
                eq(hypotheses.retired, false),
                inArray(hypotheses.id, ids),
              ),
            );
          if (rows.length !== new Set(ids).size)
            throw new DomainRuleError("Unknown or retired hypothesis");
          for (const id of ids)
            await updateHypothesis(tx, id, { userPinned: true });
        }
        return runView(
          await commitTransition(
            tx,
            raw,
            boss,
            run,
            "USER_SELECTED_HYPOTHESES",
            { selectionRecorded: true },
            {
              events: [
                {
                  ...received,
                  payload: { kind: response.kind, selectedHypothesisIds: ids },
                },
              ],
              terminalReason: null,
            },
          ),
        );
      }
      case "COUNTERFACTUAL_COST": {
        // Gate H4 (AGENT_WORKFLOW §11): the user approves the live calls a branch needs.
        if (response.action === "cancel")
          return runView(
            await commitTransition(
              tx,
              raw,
              boss,
              run,
              "CANCEL",
              {},
              {
                events: [
                  {
                    ...received,
                    payload: { kind: response.kind, action: "cancel" },
                  },
                ],
                terminalReason: "USER_CANCELLED",
              },
            ),
          );
        const budget = RunBudget.parse(run.budget);
        if (response.maxQlooCalls !== undefined) {
          // The user may lower the cap (never raise it above the run's budget).
          budget.maxQlooCalls = Math.min(
            budget.maxQlooCalls,
            response.maxQlooCalls,
          );
          await tx
            .update(agentRuns)
            .set({ budget })
            .where(eq(agentRuns.id, run.id));
        }
        return runView(
          await commitTransition(
            tx,
            raw,
            boss,
            run,
            "USER_CONFIRMED_COUNTERFACTUAL",
            {},
            {
              events: [
                {
                  ...received,
                  payload: {
                    kind: response.kind,
                    action: "run",
                    maxQlooCalls: budget.maxQlooCalls,
                  },
                },
              ],
            },
          ),
        );
      }
    }
  });
}
