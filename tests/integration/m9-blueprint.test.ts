import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SECTION_TITLE,
  type BlueprintContent,
  type TraceabilityReport,
} from "../../packages/core/src";
import {
  QUEUES,
  blueprintView,
  createCounterfactualBranch,
  exportBlueprint,
  saveUserRevision,
  sql,
  startComposition,
  startRecompose,
  type DbHandle,
  type PgBoss,
} from "../../packages/db/src";
import { startBoss } from "./helpers/exploration";
import { RUN_CONFIG, syntheticHarness } from "./helpers/synthetic";
import { createTestDatabase } from "./helpers/test-db";

/**
 * M9 composition on synthetic data and the scripted provider ($0): EB-A1 (traceability),
 * EB-A2 (constraints), EB-A3 (append-only revisions), EB-A4 (export fidelity), recompose,
 * and composing from a What-if branch.
 */
let handle: DbHandle;
let drop: () => Promise<void>;
let boss: PgBoss;
let harness: ReturnType<typeof syntheticHarness>;

beforeAll(async () => {
  const test = await createTestDatabase();
  handle = test.handle;
  drop = test.drop;
  boss = await startBoss(test.url);
  harness = syntheticHarness(handle, boss);
});
afterEach(async () => {
  await boss.deleteQueuedJobs(QUEUES.runStep);
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await drop?.();
});

const BRIEF = {
  title: "Harbor Lights supper club",
  challenge:
    "A 40-seat supper club wants a monthly night that pulls game, book and film fans together.",
  interests: [
    { text: "Stardew Harvest Tales", domainHint: "videogame" },
    { text: "Paper Atlas Stories", domainHint: "book" },
    { text: "Neon Harbor Nights", domainHint: "movie" },
  ],
  venue: { type: "cafe", capacity: 40 },
  constraints: { budgetBand: "low", durationMinutes: 120 },
  goals: ["Attract new weekday visitors"],
};

async function finishedExperiment() {
  const ids = await harness.start(BRIEF, 0.6);
  const run = await harness.driveToEnd(harness.deps("off"), ids, {
    tension: 0.6,
    select: true,
  });
  expect(run.state).toBe("COMPLETED");
  const top = await handle.db.execute<{ id: string }>(
    sql`SELECT id FROM hypotheses WHERE experiment_id = ${ids.experimentId} AND NOT retired ORDER BY composite_score DESC NULLS LAST LIMIT 2`,
  );
  return { ...ids, hypothesisIds: top.rows.map((r) => r.id) };
}

async function compose(
  ids: { workspaceId: string; experimentId: string },
  hypothesisIds: string[],
) {
  const started = await startComposition(handle, boss, {
    workspaceId: ids.workspaceId,
    experimentId: ids.experimentId,
    hypothesisIds,
    format: "event",
    runConfig: RUN_CONFIG,
  });
  const run = await harness.driveToEnd(
    harness.deps("off"),
    { ...ids, runId: started.runId },
    { tension: 0.6, select: false },
  );
  expect(run.state).toBe("COMPLETED");
  return started;
}

const allEvidence = async (experimentId: string) =>
  new Set(
    (
      await handle.db.execute<{ id: string }>(
        sql`SELECT id FROM evidence_records WHERE experiment_id = ${experimentId}`,
      )
    ).rows.map((r) => r.id),
  );

describe("M9 blueprint composition", () => {
  it("composes a traceable blueprint, keeps revisions append-only, and exports with an appendix", async () => {
    const ids = await finishedExperiment();
    const { blueprintId } = await compose(ids, ids.hypothesisIds);
    let view = await blueprintView(handle.db, ids.workspaceId, blueprintId);
    expect(view.current?.revisionNumber).toBe(1);
    expect(view.current?.author).toBe("AGENT");
    const content = view.current!.content as BlueprintContent;
    const report = view.current!.traceabilityReport as TraceabilityReport;

    // EB-A1: every block has a provenance; every citation resolves to stored evidence.
    const evidence = await allEvidence(ids.experimentId);
    const blocks = content.sections.flatMap((s) => s.blocks);
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      expect(b.provenance).toBeTruthy();
      for (const id of b.evidenceIds) expect(evidence.has(id)).toBe(true);
      // Facts cite; synthetic facts are labeled fixtures, never Qloo data.
      if (b.provenance === "DEVELOPMENT_FIXTURE")
        expect(b.evidenceIds.length).toBeGreaterThan(0);
      expect(b.provenance).not.toBe("QLOO_SOURCED");
    }
    expect(report.unresolved).toEqual([]);
    expect(report.evidenceBacked).toBeGreaterThan(0);
    expect(report.speculation + report.interpretation).toBeGreaterThan(0);
    // EB-A2: the brief has a capacity and a budget band → constraints are identified.
    expect(content.constraintsIdentified.length).toBeGreaterThanOrEqual(2);
    expect(content.constraintsIdentified.map((c) => c.key)).toEqual(
      expect.arrayContaining(["capacity", "budget"]),
    );
    // No outcome promises anywhere in the agent's text.
    expect(JSON.stringify(content)).not.toMatch(
      /guarantee|sell[- ]?out|proven demand/i,
    );

    // EB-A3: a user edit appends revision 2; revision 1 is byte-identical (hash).
    const rev1Hash = view.current!.contentHash;
    const edited: BlueprintContent = structuredClone(content);
    const programming = edited.sections.find((s) => s.kind === "programming")!;
    programming.blocks[0] = {
      ...programming.blocks[0]!,
      text: `${programming.blocks[0]!.text} Close with a quiet listening corner.`,
    };
    programming.blocks.push({
      text: "Add a tasting break between segments.",
      provenance: "QLOO_SOURCED", // a client cannot claim this; the server decides
      evidenceIds: [],
    });
    const r2 = await saveUserRevision(handle, {
      workspaceId: ids.workspaceId,
      blueprintId,
      baseRevisionId: view.current!.id,
      content: edited,
    });
    expect(r2.revisionNumber).toBe(2);
    const r2Content = r2.content as BlueprintContent;
    const p2 = r2Content.sections.find((s) => s.kind === "programming")!;
    expect(p2.blocks[0]!.edited).toBe(true);
    expect(p2.blocks.at(-1)!.provenance).toBe("USER_PROVIDED");
    const rev1 = await handle.db.execute<{ content_hash: string }>(
      sql`SELECT content_hash FROM blueprint_revisions WHERE blueprint_id = ${blueprintId} AND revision_number = 1`,
    );
    expect(rev1.rows[0]!.content_hash).toBe(rev1Hash);
    // A stale base is rejected (optimistic concurrency).
    await expect(
      saveUserRevision(handle, {
        workspaceId: ids.workspaceId,
        blueprintId,
        baseRevisionId: view.current!.id,
        content: edited,
      }),
    ).rejects.toThrow(/changed since/);

    // A restore uses the stored revision, never the client's copy: forged provenance is ignored.
    const forged: BlueprintContent = structuredClone(r2Content);
    forged.sections[0]!.blocks.unshift({
      text: "Proven demand: this night will sell out.",
      provenance: "APP_DERIVED",
      evidenceIds: [],
    });
    const restored = await saveUserRevision(handle, {
      workspaceId: ids.workspaceId,
      blueprintId,
      baseRevisionId: r2.id,
      content: forged,
      restoreOf: 1,
    });
    expect(restored.revisionNumber).toBe(3);
    expect(restored.contentHash).toBe(rev1Hash);
    expect(JSON.stringify(restored.content)).not.toContain("Proven demand");
    await expect(
      saveUserRevision(handle, {
        workspaceId: ids.workspaceId,
        blueprintId,
        baseRevisionId: restored.id,
        content: forged,
        restoreOf: 3,
      }),
    ).rejects.toThrow(/already current/);
    // Back to the edited content for the export checks below.
    const r4 = await saveUserRevision(handle, {
      workspaceId: ids.workspaceId,
      blueprintId,
      baseRevisionId: restored.id,
      content: forged,
      restoreOf: 2,
    });
    expect(r4.contentHash).toBe(r2.contentHash);

    // EB-A4: Markdown has every section, every block's provenance label, and the appendix.
    const md = await exportBlueprint(
      handle.db,
      { workspaceId: ids.workspaceId },
      blueprintId,
      "md",
    );
    for (const title of Object.values(SECTION_TITLE))
      expect(md.body).toContain(`## ${title}`);
    expect(md.body).toContain("## Evidence appendix");
    expect(md.body).toContain("Development fixtures — not real Qloo data");
    expect(md.body).toMatch(/\| E-1 \|.*\| \d{4}-\d{2}-\d{2} \|/);
    const blockLines = md.body
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes(" — _"));
    expect(blockLines.length).toBe(
      r2Content.sections.flatMap((s) => s.blocks).length,
    );
    expect(md.body).toContain("edited by you");
    const json = JSON.parse(
      (
        await exportBlueprint(
          handle.db,
          { workspaceId: ids.workspaceId },
          blueprintId,
          "json",
        )
      ).body,
    );
    expect(json.evidenceAppendix.length).toBeGreaterThan(0);
    expect(json.content.title).toBe(r2Content.title);

    // Recompose one section with an instruction → revision 5, other sections untouched.
    const re = await startRecompose(handle, boss, {
      workspaceId: ids.workspaceId,
      blueprintId,
      section: "promotion",
      instruction: "Focus on neighborhood notice boards",
      runConfig: RUN_CONFIG,
    });
    const run = await harness.driveToEnd(
      harness.deps("off"),
      { ...ids, runId: re.runId },
      { tension: 0.6, select: false },
    );
    expect(run.state).toBe("COMPLETED");
    view = await blueprintView(handle.db, ids.workspaceId, blueprintId);
    expect(view.current!.revisionNumber).toBe(5);
    const c3 = view.current!.content as BlueprintContent;
    expect(c3.sections.find((s) => s.kind === "programming")).toEqual(
      r2Content.sections.find((s) => s.kind === "programming"),
    );
    expect(
      JSON.stringify(c3.sections.find((s) => s.kind === "promotion")),
    ).toContain("neighborhood notice boards");
    expect(view.revisions.map((r) => r.author)).toEqual([
      "AGENT",
      "USER",
      "USER",
      "USER",
      "AGENT",
    ]);
  });

  it("refuses to compose while the selection gate is open, and composes from a What-if branch", async () => {
    const ids = await harness.start(BRIEF, 0.6);
    const run = await harness.driveToEnd(harness.deps("off"), ids, {
      tension: 0.6,
      select: true,
    });
    expect(run.state).toBe("COMPLETED");
    // A rescore-only branch of the finished experiment.
    const branch = await createCounterfactualBranch(handle, boss, {
      workspaceId: ids.workspaceId,
      experimentId: ids.experimentId,
      delta: {
        scoringWeights: { support: 0.6, novelty: 0.2, feasibility: 0.2 },
      },
      mode: "hold_hypotheses",
      runConfig: RUN_CONFIG,
    });
    const bRun = await harness.driveToEnd(
      harness.deps("off"),
      {
        workspaceId: ids.workspaceId,
        experimentId: branch.branchExperimentId,
        runId: branch.runId!,
      },
      { tension: 0.6, select: false },
    );
    expect(bRun.state).toBe("COMPLETED");
    const hyp = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM hypotheses WHERE experiment_id = ${branch.branchExperimentId} ORDER BY composite_score DESC LIMIT 1`,
    );
    const { blueprintId } = await compose(
      { workspaceId: ids.workspaceId, experimentId: branch.branchExperimentId },
      [hyp.rows[0]!.id],
    );
    const view = await blueprintView(handle.db, ids.workspaceId, blueprintId);
    const content = view.current!.content as BlueprintContent;
    const evidence = await allEvidence(branch.branchExperimentId);
    // Branch evidence is reused parent evidence (CACHE) and still resolves end to end.
    const cited = content.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) => b.evidenceIds);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(evidence.has(id)).toBe(true);
    // Reused fixture data stays labeled as fixture data (never "CACHE" alone, never Qloo).
    expect(view.appendix.every((a) => a.reused)).toBe(true);
    expect(view.appendix.every((a) => a.dataOrigin === "FIXTURE")).toBe(true);
    const md = await exportBlueprint(
      handle.db,
      { workspaceId: ids.workspaceId },
      blueprintId,
      "md",
    );
    expect(md.body).toContain("| FIXTURE — not Qloo data (reused) |");

    // An exploration paused at H3 cannot compose until the selection is recorded.
    const third = await harness.start(
      { ...BRIEF, title: "Another night" },
      0.7,
    );
    const paused = await harness.driveToEnd(harness.deps("off"), third, {
      tension: 0.7,
      select: true,
      stopAt: "HYPOTHESIS_SELECTION",
    });
    expect(paused.state).toBe("AWAITING_HYPOTHESIS_SELECTION");
    const hRow = await handle.db.execute<{ id: string }>(
      sql`SELECT id FROM hypotheses WHERE experiment_id = ${third.experimentId} LIMIT 1`,
    );
    await expect(
      startComposition(handle, boss, {
        workspaceId: third.workspaceId,
        experimentId: third.experimentId,
        hypothesisIds: [hRow.rows[0]!.id],
        format: "event",
        runConfig: RUN_CONFIG,
      }),
    ).rejects.toThrow(/selection first/);
  });
});
