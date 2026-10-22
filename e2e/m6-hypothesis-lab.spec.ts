import {
  createProject,
  expectAccessible,
  expectFixtureBanner,
  fillBrief,
  snap,
  expect,
  test,
} from "./helpers";

// Typed multi-word titles resolve exactly on the synthetic transport, so this run goes
// H1 → discovery → H2b (pool) → loop → H3 without an entity choice.
const BRIEF = {
  title: "Harbor Lights supper club",
  challenge:
    "A 40-seat supper club wants a monthly night that pulls game, book and film fans together.",
  interests: [
    ["Stardew Harvest Tales", "videogame"],
    ["Paper Atlas Stories", "book"],
    ["Neon Harbor Nights", "movie"],
  ] as [string, string?][],
  capacity: "40",
};

const meterValue = async (
  page: import("@playwright/test").Page,
  name: string,
) =>
  Number(
    await page
      .getByRole("meter", { name, exact: true })
      .first()
      .getAttribute("aria-valuenow"),
  );

test("H2b + E2E-05 + E2E-06: pool tension → live loop → Hypothesis Lab, evidence drawer and trace → H3", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await createProject(page, "Harbor Lights");
  await fillBrief(page, BRIEF);
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await page.getByRole("button", { name: "Confirm & discover" }).click();
  await page.getByRole("link", { name: "Open the Discovery canvas" }).click();

  // Gate H2b: the collision pool with its tension slider (UI_UX_SPEC §4.3).
  await expect(page.getByText("Review the collision pool")).toBeVisible({
    timeout: 60_000,
  });
  const pool = page.getByRole("region", { name: "Collision pool" });
  await expect(pool).toBeVisible();
  expect(await pool.getByTestId("pool-item").count()).toBeGreaterThanOrEqual(3);
  const before = await pool.getByTestId("pool-item").allInnerTexts();
  const slider = pool.getByLabel(/Collision tension/);
  await slider.focus();
  await page.keyboard.press("End"); // τ = 0.90, "Unexpected"
  await expect(pool).toContainText("Unexpected");
  await expect(pool).toContainText("τ = 0.90");
  await expect(
    pool.getByText(/candidates differ from the pool the agent proposed/),
  ).toBeVisible();
  const after = await pool.getByTestId("pool-item").allInnerTexts();
  expect(after).not.toEqual(before); // CC-A2: tension changes the preview
  await expectFixtureBanner(page);
  await expect(
    page.getByTestId("discovery-canvas").locator(".react-flow__node").first(),
  ).toBeVisible();
  await page
    .getByTestId("discovery-canvas")
    .screenshot({ path: info.outputPath("discovery-canvas-pool.png") });
  await expectAccessible(page);
  await snap(page, info, "discovery-pool");

  const qlooBefore = await meterValue(page, "Qloo calls");
  const llmBefore = await meterValue(page, "LLM calls");
  await pool
    .getByRole("button", { name: "Generate hypotheses with this pool" })
    .click();
  await expect(pool.getByText("The pool was committed")).toBeVisible();

  // E2E-05: the loop streams into the dock; the lab fills in as evidence arrives.
  await page.goto(page.url().replace(/\/discovery$/, "/hypotheses"));
  await expect(
    page.getByRole("heading", { name: "Hypothesis lab" }),
  ).toBeVisible();
  const bar = page.getByRole("region", { name: "Select hypotheses" });
  await expect(bar).toBeVisible({ timeout: 90_000 });
  expect(await meterValue(page, "Qloo calls")).toBeGreaterThan(qlooBefore);
  expect(await meterValue(page, "LLM calls")).toBeGreaterThan(llmBefore);
  // Events render in sequence order with no gaps (AM-A2, UI side).
  const seqs = (
    await page
      .getByLabel("Run timeline")
      .locator("[data-seq]")
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-seq"))))
  ).filter((n) => Number.isFinite(n));
  expect(seqs.length).toBeGreaterThan(10);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length);

  const cards = page.getByTestId("hypothesis-card");
  expect(await cards.count()).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("iteration-timeline")).toContainText(
    "Iteration 1",
  );
  // Final hypotheses show stances (status pill + claim tallies) and provenance chips.
  const first = cards.first();
  await expect(first.locator("[data-status]").first()).toBeVisible();
  await expect(first.getByLabel("Claim results")).toContainText("supports");
  await expect(
    first.locator("[data-provenance=CREATIVE_SPECULATION]"),
  ).toBeVisible();
  // HL-A5: superseded or retired hypotheses stay visible in a collapsed group.
  const retired = page.getByTestId("retired-group");
  if (await retired.count()) {
    await retired.locator("summary").click();
    await expect(retired.getByTestId("hypothesis-card").first()).toBeVisible();
  }
  await expectFixtureBanner(page);
  await expectAccessible(page);
  await snap(page, info, "hypothesis-lab");

  // Score breakdown: weights, contributions, every feasibility rule applied.
  await first.getByRole("button", { name: "Score breakdown" }).click();
  const breakdown = first.getByTestId("score-breakdown");
  await expect(breakdown).toContainText("Composite");
  await expect(breakdown).toContainText("feasibility-1.0.0");
  // M8: re-weighting is available once the loop has finished (a rescore-only branch).
  await expect(
    breakdown.getByRole("button", { name: "Adjust weights" }),
  ).toBeEnabled();
  await expect(breakdown).toContainText("rescore-only branch");

  // E2E-06: evidence drawer → trace with redacted request, envelope, pointer value, rule.
  await first.getByRole("button", { name: "Inspect evidence" }).click();
  const drawer = page
    .getByRole("dialog")
    .filter({ has: page.getByTestId("claim") });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("claim").first()).toBeVisible();
  await expect(drawer.getByTestId("evidence-rule").first()).toContainText(
    /(SUPPORTS|CONTRADICTS|NEUTRAL|INSUFFICIENT) because/,
  );
  await expect(
    drawer.locator("[data-provenance=DEVELOPMENT_FIXTURE]").first(),
  ).toBeVisible();
  await expectAccessible(page, "dialog[open]");
  await snap(page, info, "evidence-drawer");

  const withFacts = drawer
    .getByTestId("evidence-item")
    .filter({ hasText: / = / })
    .filter({ has: page.getByRole("button", { name: "Trace" }) })
    .first();
  const rule = (
    await withFacts.getByTestId("evidence-rule").innerText()
  ).replace(/^Evaluator rule:\s*/, "");
  await withFacts.getByRole("button", { name: "Trace" }).click();
  const trace = page.getByRole("dialog", { name: "Trace: request to result" });
  await expect(trace.getByTestId("trace-envelope")).toBeVisible();
  await expect(trace.getByTestId("trace-envelope")).toContainText(
    /ok|partial|empty/i,
  );
  await expect(trace.getByTestId("trace-args")).toBeVisible();
  await expect(trace.getByTestId("trace-fact").first()).toContainText(
    /^.+\/.+/,
  );
  await expect(trace.getByTestId("trace-fact").first()).toContainText(
    "at ingest ✓",
  );
  await expect(trace).toContainText(rule.trim().slice(0, 40));
  await expect(trace).toContainText("FIXTURE — not Qloo data");
  await expectAccessible(page, "dialog[open]:last-of-type");
  await snap(page, info, "evidence-trace");
  await trace.getByRole("button", { name: "Close trace" }).click();
  await drawer.getByRole("button", { name: "Close evidence" }).click();

  // Gate H3: pick one hypothesis and finish; the selection is kept for the blueprint (M9).
  await expect(
    bar.getByRole("button", { name: "Compose blueprint" }),
  ).toBeDisabled();
  await first.getByRole("checkbox", { name: "Select" }).check();
  await expect(bar).toContainText("1 selected");
  await bar.getByRole("button", { name: "Save selection and finish" }).click();
  await expect(bar).toBeHidden();
  await expect(page.getByText("Selected", { exact: true })).toBeVisible();
  await expect(page.getByTestId("run-state")).toContainText(/complete/i);
});
