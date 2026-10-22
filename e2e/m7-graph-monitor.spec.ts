import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  expectAccessible,
  expectFixtureBanner,
  fillBrief,
  runToSelection,
  snap,
  TYPED_BRIEF,
} from "./helpers";

async function experimentId(page: Page, projectUrl: string) {
  const projectId = projectUrl.split("/projects/")[1]!.split("/")[0]!;
  const res = await page.request.get(`/api/v1/projects/${projectId}`);
  const overview = (await res.json()) as {
    experiments: { id: string; latestRun: { id: string } | null }[];
  };
  return {
    experimentId: overview.experiments[0]!.id,
    runId: overview.experiments[0]!.latestRun!.id,
  };
}

/** Focused graph node's type (the wrapper React Flow focuses holds our card). */
const focusedType = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.querySelector<HTMLElement>("[data-node-type]")
        ?.dataset.nodeType ?? null,
  );

test("M7 evidence graph: provenance labels, keyboard navigation, inspector trace, list equivalence", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const projectUrl = await runToSelection(page, "Graph journey");
  await page.getByRole("tab", { name: "Evidence graph" }).click();
  const canvas = page.getByTestId("graph-canvas");
  await expect(canvas.locator("[data-node-type]").first()).toBeVisible();

  // EG-A1: every node type × provenance carries a text label (not color alone).
  await expect(
    canvas.locator('[data-node-type="hypothesis"]').first(),
  ).toContainText("Creative speculation");
  await expect(
    canvas.locator('[data-node-type="claim"]').first(),
  ).toContainText("AI interpretation");
  await expect(
    canvas.locator('[data-node-type="entity"]').first(),
  ).toContainText("FIXTURE — not Qloo data");
  await expectFixtureBanner(page);
  await expectAccessible(page);
  await snap(page, info, "evidence-graph");

  // Keyboard: Tab to a hypothesis, → follows its claim, → its evidence, Enter inspects.
  await canvas
    .locator(".react-flow__node")
    .filter({ has: page.locator('[data-node-type="hypothesis"]') })
    .first()
    .focus();
  expect(await focusedType(page)).toBe("hypothesis");
  await page.keyboard.press("ArrowRight");
  expect(await focusedType(page)).toBe("claim");
  await expect(page.getByTestId("graph-announcer")).toContainText("Claim");
  await page.keyboard.press("ArrowRight");
  expect(await focusedType(page)).toBe("evidence");
  await page.keyboard.press("Enter");
  const inspector = page.getByLabel(/^Inspector:/);
  await expect(inspector).toContainText("Evidence");
  await expect(inspector).toContainText("FIXTURE — not Qloo data");
  // EG-A3: a data-backed node always offers a trace.
  await inspector.getByRole("button", { name: "Trace" }).click();
  const trace = page.getByRole("dialog", { name: "Trace: request to result" });
  await expect(trace.getByTestId("trace-envelope")).toBeVisible();
  await expect(trace.getByTestId("trace-fact").first()).toContainText(
    "at ingest ✓",
  );
  await expectAccessible(page, "dialog[open]");
  await trace.getByRole("button", { name: "Close trace" }).click();
  await snap(page, info, "evidence-graph-inspector");

  // EG-A4: the List view lists every node and every shown connection.
  const { experimentId: id } = await experimentId(page, projectUrl);
  const api = (await (
    await page.request.get(`/api/v1/experiments/${id}/graph?include=retired`)
  ).json()) as { nodes: unknown[]; edges: { kind: string }[] };
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.getByTestId("graph-list");
  await expect(list.getByTestId("graph-list-node")).toHaveCount(
    api.nodes.length,
  );
  // Citation links are off by default in both views; turning them on shows them in both.
  await expect(list.getByTestId("graph-list-edge")).toHaveCount(
    api.edges.filter((e) => e.kind !== "CITES").length,
  );
  await page.getByLabel("Citation links").check();
  await expect(list.getByTestId("graph-list-edge")).toHaveCount(
    api.edges.length,
  );
  await expectAccessible(page);
});

test("M7 activity monitor: first event latency, reconnect without gaps, full view, cancel", async ({
  page,
  context,
}, info) => {
  test.setTimeout(150_000);
  await createProject(page, "Monitor journey");
  await fillBrief(page, TYPED_BRIEF);
  const timeline = page.getByLabel("Run timeline").locator("[data-seq]");
  const t0 = Date.now();
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await expect(timeline.first()).toBeVisible({ timeout: 3_000 }); // AM-A1
  const latencyMs = Date.now() - t0;
  info.annotations.push({
    type: "AM-A1 first event ms",
    description: String(latencyMs),
  });

  await page.getByRole("button", { name: "Confirm & discover" }).click();
  await page.getByRole("link", { name: "Open the Discovery canvas" }).click();
  await expect(page.getByText("Review the collision pool")).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("region", { name: "Collision pool" })
    .getByRole("button", { name: "Generate hypotheses with this pool" })
    .click();
  await expect(page.getByText("The pool was committed")).toBeVisible();
  // Drop the connection while the loop runs; EventSource resumes with Last-Event-ID.
  await context.setOffline(true);
  await page.waitForTimeout(1_500);
  await context.setOffline(false);
  await page.goto(page.url().replace(/\/discovery$/, "/hypotheses"));
  await expect(
    page.getByRole("region", { name: "Select hypotheses" }),
  ).toBeVisible({ timeout: 90_000 });

  // AM-A2: the UI shows exactly the stored events, in order, with no gaps or duplicates.
  const projectUrl = page.url().replace(/\/hypotheses$/, "");
  const { runId } = await experimentId(page, projectUrl);
  const sse = await (
    await page.request.get(`/api/v1/runs/${runId}/events?after=0`)
  ).text();
  const stored = [...sse.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  await page
    .getByRole("button", { name: "Open the full activity view" })
    .click();
  const full = page.getByRole("dialog", {
    name: "Decisions & actions — full view",
  });
  const seqs = await full
    .getByTestId("full-timeline")
    .locator("[data-seq]")
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-seq"))));
  expect(seqs).toEqual(stored);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  await expect(full).toContainText("complete and in order");
  await expect(full.getByTestId("tool-stats")).toContainText("recommend");
  await expect(full.getByTestId("tool-stats")).toContainText(
    "fixture (not Qloo data)",
  );
  await expect(full.getByTestId("llm-stats")).toContainText("scripted-demo");
  await full.getByRole("button", { name: "View as table" }).click();
  await expect(
    full.getByRole("cell", { name: "waiting for you" }).first(),
  ).toBeVisible();
  await expectAccessible(page, "dialog[open]");
  await snap(page, info, "activity-full");
  await full.getByRole("button", { name: "Close full view" }).click();

  // AM-A4 / E2E-11: cancel → CANCELLED within 5 s; partial results stay, clearly marked.
  const cancelledAt = Date.now();
  await page
    .getByRole("complementary", { name: "Decisions and actions" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByTestId("run-state")).toContainText("cancelled", {
    timeout: 5_000,
  });
  expect(Date.now() - cancelledAt).toBeLessThan(5_000);
  await expect(page.getByTestId("partial-ribbon")).toContainText(
    "Run cancelled — evidence incomplete",
  );
  await expect(page.getByTestId("hypothesis-card").first()).toBeVisible();
  await expectAccessible(page);
});

/** A synthetic 300-node / 600-edge graph in the API's shape (EG-A2 load test only). */
function largeGraph() {
  const id = (n: number) =>
    `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const P = "DEVELOPMENT_FIXTURE";
  for (let i = 0; i < 40; i++)
    nodes.push({
      id: id(i),
      type: "entity",
      label: `Entity ${i}`,
      provenance: P,
      invocationId: id(9000 + i),
      data: { kind: "entity", domain: "book", seed: i < 3, location: false },
    });
  for (let h = 0; h < 30; h++) {
    const hid = id(100 + h);
    nodes.push({
      id: hid,
      type: "hypothesis",
      label: `Hypothesis ${h}`,
      provenance: "CREATIVE_SPECULATION",
      invocationId: null,
      data: {
        status: "PARTIALLY_SUPPORTED",
        retired: false,
        iteration: 0,
        composite: 90 - h,
      },
    });
    for (const e of [h % 40, (h * 7 + 3) % 40])
      edges.push({
        id: `ELEMENT_OF:${id(e)}->${hid}`,
        source: id(e),
        target: hid,
        kind: "ELEMENT_OF",
        provenance: "CREATIVE_SPECULATION",
        label: "woven into",
      });
    if (h > 0)
      edges.push({
        id: `REVISION_OF:${id(99 + h)}->${hid}`,
        source: id(99 + h),
        target: hid,
        kind: "REVISION_OF",
        provenance: "MODEL_INTERPRETATION",
        label: "revised as",
      });
    for (let c = 0; c < 3; c++) {
      const cid = id(1000 + h * 3 + c);
      nodes.push({
        id: cid,
        type: "claim",
        label: `Claim ${h}.${c}`,
        provenance: "MODEL_INTERPRETATION",
        invocationId: null,
        data: {
          ordinal: c,
          testKind: "CROSS_DOMAIN_AFFINITY",
          status: "TESTED",
          stance: "SUPPORTS",
          hypothesisId: hid,
        },
      });
      edges.push({
        id: `HAS_CLAIM:${hid}->${cid}`,
        source: hid,
        target: cid,
        kind: "HAS_CLAIM",
        provenance: "MODEL_INTERPRETATION",
        label: "claims",
      });
    }
  }
  for (let v = 0; v < 140; v++) {
    const claim = id(1000 + (v % 90));
    const vid = id(5000 + v);
    nodes.push({
      id: vid,
      type: "evidence",
      label: "SUPPORTS",
      provenance: P,
      invocationId: id(7000 + v),
      data: {
        stance: "SUPPORTS",
        evaluatorId: "CROSS_DOMAIN_AFFINITY@r",
        quality: "FULL",
        claimId: claim,
        hypothesisId: id(100 + Math.floor((v % 90) / 3)),
      },
    });
    edges.push({
      id: `TESTED_BY:${claim}->${vid}`,
      source: claim,
      target: vid,
      kind: "TESTED_BY",
      provenance: "APP_DERIVED",
      label: "tested by",
    });
    for (const e of [v % 40, (v * 3 + 1) % 40])
      if (edges.length < 600)
        edges.push({
          id: `CITES:${vid}->${id(e)}`,
          source: vid,
          target: id(e),
          kind: "CITES",
          provenance: P,
          label: "cites",
        });
  }
  // Top up to exactly 600 with extra (distinct) citation links.
  for (let k = 0; edges.length < 600; k++)
    edges.push({
      id: `CITES:${id(5000 + k)}->${id(39 - (k % 10))}:extra`,
      source: id(5000 + k),
      target: id(39 - (k % 10)),
      kind: "CITES",
      provenance: P,
      label: "cites",
    });
  return {
    version: "graph-1.0.0",
    nodes,
    edges: edges.slice(0, 600),
    layout: null,
  };
}

test("EG-A2 (reported): 300 nodes / 600 edges render time and pan frame rate", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await runToSelection(page, "Graph load");
  const big = largeGraph();
  expect(big.nodes).toHaveLength(300);
  expect(big.edges).toHaveLength(600);
  await page.route(/\/graph\?include=/, (route) =>
    route.fulfill({ json: big }),
  );
  const t0 = Date.now();
  await page.getByRole("tab", { name: "Evidence graph" }).click();
  await page.getByLabel("Citation links").check({ timeout: 10_000 });
  await expect(
    page.getByTestId("graph-canvas").locator("[data-node-type]").first(),
  ).toBeVisible();
  const renderMs = Date.now() - t0;
  const canvas = page.getByTestId("graph-canvas");
  const box = (await canvas.boundingBox())!;
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const panStart = Date.now();
  const framesDuringPan = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 1000) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
  );
  for (let i = 0; i < 30; i++)
    await page.mouse.move(
      box.x + box.width / 2 - i * 8,
      box.y + box.height / 2 - i * 5,
    );
  await page.mouse.up();
  const panFps = await framesDuringPan;
  const report = {
    renderMs,
    idleFps: fps,
    panFps,
    panMs: Date.now() - panStart,
  };
  info.annotations.push({ type: "EG-A2", description: JSON.stringify(report) });
  console.info("EG-A2", JSON.stringify(report));
  if (renderMs > 1500 || panFps < 30)
    console.warn("EG-A2 warning threshold exceeded", JSON.stringify(report));
});
