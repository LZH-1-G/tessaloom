import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectAccessible,
  expectFixtureBanner,
  runToSelection,
  snap,
} from "./helpers";

test("E2E-07 + E2E-08: seed swap → H4 → comparison with entered/exited and stance changes; adjust weights → rescore-only branch", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const projectUrl = await runToSelection(page, "What-if swap");
  await page.goto(`${projectUrl}/what-if`);
  await expect(
    page.getByRole("heading", { name: "What-if lab" }),
  ).toBeVisible();
  await expectFixtureBanner(page);

  // Swap the first seed for the first discovered alternative.
  const swap = page.getByLabel(/^Swap .+ for$/).first();
  const value = await swap.locator("option").nth(1).getAttribute("value");
  await swap.selectOption(value!);
  const preview = page.getByTestId("branch-preview");
  await expect(preview.getByTestId("preview-summary")).toContainText(
    /This change affects \d+ Qloo quer(y|ies); \d+ will be reused/,
  );
  await expectAccessible(page);
  await snap(page, info, "whatif-preview");
  const planned = Number(
    /affects (\d+)/.exec(
      (await preview.getByTestId("preview-summary").innerText()) ?? "",
    )![1],
  );
  await preview.getByRole("button", { name: "Run branch" }).click();
  await expect(page).toHaveURL(/what-if\?branch=/);

  // Gate H4 when more than 6 calls are needed (AGENT_WORKFLOW §11).
  if (planned > 6) {
    const gate = page.getByTestId("cost-gate");
    await expect(gate).toContainText(`Approve ${planned} Qloo calls?`);
    await expectAccessible(page);
    await gate.getByRole("button", { name: "Run", exact: true }).click();
  }

  const header = page.getByTestId("comparison-header");
  await expect(header).toBeVisible({ timeout: 60_000 });
  // WI-A2: the header always reports re-run, reused, and new result counts.
  await expect(header).toContainText(
    new RegExp(`Queries re-run\\s*${planned}`),
  );
  await expect(header.getByText("Queries re-run")).toBeVisible();
  await expect(header.getByText("Queries reused")).toBeVisible();
  await expect(header.getByText("New Qloo results")).toBeVisible();
  // Genuine recomputation: re-run queries show what entered and exited.
  const diffs = page.getByTestId("query-diffs");
  await expect(diffs).toContainText("＋ Entered");
  await expect(diffs).toContainText("− Exited");
  await expect(page.getByTestId("hypothesis-deltas")).toBeVisible();

  // WI-A4: every number in the narrative is a metric rendered elsewhere on the page.
  const narrative = await page.getByTestId("narrative").innerText();
  const elsewhere = (await page.getByTestId("comparison-view").innerText())
    .replace(narrative, "")
    .match(/\d+(?:\.\d+)?/g);
  const allowed = new Set(elsewhere ?? []);
  const numbers = narrative.match(/\d+(?:\.\d+)?/g) ?? [];
  expect(numbers.length).toBeGreaterThan(0);
  for (const n of numbers)
    expect(allowed, `narrative number ${n}`).toContain(n);
  await expect(
    page.getByRole("region").filter({ hasText: "What changed" }).first(),
  ).toBeVisible();
  await expectFixtureBanner(page);
  await expectAccessible(page);
  await snap(page, info, "whatif-comparison");

  // Charts have table views (UI_UX_SPEC §8).
  await page.getByRole("button", { name: "View as table" }).first().click();
  await expect(page.getByRole("cell", { name: "Parent" }).first()).toBeHidden();
  await expectAccessible(page);

  await adjustWeights(page, info, projectUrl);
});

/**
 * E2E-08 on the same finished parent: "Adjust weights" creates a rescore-only branch that is
 * labeled "no new Qloo data" with dirty = 0 (branching never changes the parent).
 */
async function adjustWeights(page: Page, info: TestInfo, projectUrl: string) {
  await page.goto(`${projectUrl}/hypotheses`);
  const card = page.getByTestId("hypothesis-card").first();
  await card.getByRole("button", { name: "Score breakdown" }).click();
  await card.getByRole("button", { name: "Adjust weights" }).click();
  const dialog = page.getByRole("dialog", { name: "Adjust scoring weights" });
  await expect(dialog).toBeVisible();
  const support = dialog.getByLabel("Support (evidence)");
  await support.focus();
  await page.keyboard.press("End"); // 100% support → the others rebalance to 0
  await expect(dialog).toContainText("100%");
  await expectAccessible(page, "dialog[open]");
  await dialog
    .getByRole("button", { name: "Create rescore-only branch" })
    .click();
  await expect(page).toHaveURL(/what-if\?branch=/);
  await expect(page.getByTestId("rescore-label")).toContainText(
    "Rescored with existing evidence — no new Qloo data was retrieved.",
    { timeout: 60_000 },
  );
  const header = page.getByTestId("comparison-header");
  await expect(header).toContainText(/Queries re-run\s*0/);
  await expect(header).toContainText(/New Qloo results\s*0/);
  const narrative = page.getByTestId("narrative");
  await expect(narrative).toContainText(/no new Qloo data/i);
  await expect(narrative).not.toContainText(/fresh|re-?queried|new results/i);
  await expect(page.getByTestId("branch-tree")).toContainText(
    "Re-weighted scores",
  );
  await expectFixtureBanner(page);
  await expectAccessible(page);
  await snap(page, info, "whatif-rescore");
}
