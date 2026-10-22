import { readFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import {
  expectAccessible,
  expectFixtureBanner,
  runToSelection,
  snap,
  watchCsp,
  expect,
  test,
} from "./helpers";

/** Gate H3 → select the top card → "Compose blueprint" records the selection and composes. */
async function composeFromLab(page: Page, info: TestInfo) {
  await page
    .getByTestId("hypothesis-card")
    .first()
    .getByLabel("Select", { exact: true })
    .check();
  await page
    .getByRole("region", { name: "Select hypotheses" })
    .getByRole("button", { name: "Compose blueprint" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Compose a blueprint" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await expectAccessible(page, "dialog[open]");
  await snap(page, info, "blueprint-compose");
  await dialog.getByRole("button", { name: "Compose blueprint" }).click();
  await expect(page).toHaveURL(/\/blueprint\?id=/);
}

/** The composed blueprint renders live (no reload): meter, sections, constraints, appendix. */
async function expectComposed(page: Page) {
  await expect(page.getByTestId("blueprint-title")).not.toHaveText(
    /Composing/,
    { timeout: 60_000 },
  );
  const meter = page.getByTestId("traceability-meter");
  await expect(meter).toContainText("evidence-backed");
  await expect(meter).toContainText("all resolve to stored evidence");
  await expect(meter).toContainText("not attendance or sales");
  await expect(page.getByTestId("constraints")).toContainText("Source: brief");
  await expect(page.getByTestId("evidence-appendix")).toContainText("E-1");
  await expectFixtureBanner(page);
}

test("E2E-09: compose from H3 → traceability meter → citation trace → edit → Markdown export → restore → accept", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await runToSelection(page, "Blueprint compose");
  await composeFromLab(page, info);
  await expectComposed(page);
  await expectAccessible(page);
  await snap(page, info, "blueprint");

  // Facts are fixture/app-derived and cite evidence; ideas are labelled as AI or speculation.
  const audience = page.getByTestId("section-audience");
  await expect(audience).toContainText("FIXTURE — not Qloo data");
  await expect(page.getByTestId("blueprint-document")).toContainText(
    "Creative speculation",
  );

  // A citation opens the stored evidence trace.
  await audience
    .getByRole("button", { name: /^Open evidence E-1/ })
    .first()
    .click();
  const trace = page.getByRole("dialog", { name: "Trace: request to result" });
  await expect(trace.getByTestId("trace-envelope")).toBeVisible();
  await expect(trace).toContainText("FIXTURE — not Qloo data");
  await expectAccessible(page, "dialog[open]");
  await snap(page, info, "blueprint-trace");
  await trace.getByRole("button", { name: "Close trace" }).click();

  // Editing a cited block keeps its provenance and citations and creates revision 2.
  const programming = page.getByTestId("section-programming");
  await programming
    .getByRole("button", { name: "Edit block 1 in Programming" })
    .click();
  const editor = programming.getByRole("textbox");
  await editor.fill(`${await editor.inputValue()} Keep the welcome short.`);
  await programming
    .getByRole("button", { name: "Save as new revision" })
    .click();
  const history = page.getByTestId("revision-history");
  await expect(history).toContainText("Revision 2");
  await expect(programming).toContainText("Keep the welcome short.");
  await expect(programming.getByText("Edited by you")).toBeVisible();
  await expect(
    programming.getByRole("button", { name: /^Open evidence E-/ }).first(),
  ).toBeVisible();

  // Markdown export: provenance, citations, fixture label, evidence appendix.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export Markdown" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-r2\.md$/);
  const path = info.outputPath("blueprint-sample.md");
  await download.saveAs(path);
  const md = await readFile(path, "utf8");
  expect(md).toContain("Development fixtures — not real Qloo data");
  expect(md).toContain("## Provenance legend");
  expect(md).toContain("## Evidence appendix");
  expect(md).toContain("Keep the welcome short.");
  expect(md).toMatch(/\[E-1\]/);
  expect(md).toContain("not attendance, sales, or commercial success");

  // Past revisions are read-only; restoring creates revision 3 with the old content.
  await history.getByRole("button", { name: /Revision 1/ }).click();
  await expect(page.getByText("Viewing revision 1 (read-only).")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit block/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Restore as new revision" }).click();
  await expect(history).toContainText("Revision 3");
  await expect(programming).not.toContainText("Keep the welcome short.");

  await page.getByRole("button", { name: "Accept blueprint" }).click();
  await expect(page.getByTestId("blueprint-status")).toHaveText("Accepted");

  // Print keeps the document and drops the app chrome.
  await page.emulateMedia({ media: "print" });
  await expect(history).toBeHidden();
  await expect(page.getByTestId("blueprint-document")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await expectAccessible(page);
});

test("E2E-10 + journey: What-if branch → blueprint from the branch → read-only share → revoke", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const projectUrl = await runToSelection(page, "Blueprint share");

  // A rescore-only What-if branch (no new Qloo data) is a valid source for a blueprint.
  const card = page.getByTestId("hypothesis-card").first();
  await card.getByRole("button", { name: "Score breakdown" }).click();
  await card.getByRole("button", { name: "Adjust weights" }).click();
  const weights = page.getByRole("dialog", { name: "Adjust scoring weights" });
  await weights.getByLabel("Support (evidence)").focus();
  await page.keyboard.press("End");
  await weights
    .getByRole("button", { name: "Create rescore-only branch" })
    .click();
  await expect(page).toHaveURL(/what-if\?branch=/);
  await expect(page.getByTestId("rescore-label")).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("button", { name: "Compose a blueprint from this branch" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Compose a blueprint" });
  await expect(dialog).toContainText("From the What-if branch");
  await dialog.getByLabel("Recurring series").check();
  await dialog.getByRole("button", { name: "Compose blueprint" }).click();
  await expect(page).toHaveURL(/\/blueprint\?id=/);
  await expectComposed(page);
  await expect(page.getByText("from a What-if branch")).toBeVisible();
  // Reused evidence keeps its fixture label (and says it was reused).
  await expect(page.getByTestId("evidence-appendix")).toContainText(
    "FIXTURE — not Qloo data (reused)",
  );
  await expectAccessible(page);
  await snap(page, info, "blueprint-branch");

  // Share read-only: the token is shown once.
  await page.getByRole("button", { name: "Share read-only" }).click();
  const share = page.getByRole("dialog", { name: "Share read-only" });
  await share.getByRole("button", { name: "Create link" }).click();
  const url = await share.getByTestId("share-url").inputValue();
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{43}$/);
  await expectAccessible(page, "dialog[open]");
  await snap(page, info, "blueprint-share-dialog");

  // A visitor with no workspace sees the blueprint and nothing that changes it.
  const visitor = await browser.newContext();
  const shared = await visitor.newPage();
  watchCsp(shared);
  const res = await shared.goto(url);
  expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(shared.getByTestId("readonly-badge")).toBeVisible();
  await expectFixtureBanner(shared);
  await expect(shared.getByTestId("traceability-meter")).toContainText(
    "evidence-backed",
  );
  await expect(shared.getByTestId("evidence-appendix")).toContainText("E-1");
  for (const name of [
    /^Edit/,
    /^Remove/,
    "Recompose section",
    "Share read-only",
    "Accept blueprint",
    "Cancel",
  ])
    await expect(shared.getByRole("button", { name })).toHaveCount(0);
  expect(await shared.content()).not.toContain(projectUrl.split("/").at(-1)!);
  await expectAccessible(shared);
  await snap(shared, info, "shared-view");

  // Revocation is immediate.
  await share.getByRole("button", { name: "Revoke" }).click();
  await expect(share.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  await shared.reload();
  await expect(
    shared.getByText("This link is no longer active."),
  ).toBeVisible();
  await expect(shared.getByTestId("blueprint-document")).toHaveCount(0);
  await expectAccessible(shared);
  await visitor.close();
});
