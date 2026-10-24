import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import {
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * Each test is one anonymous visitor. Behind the production proxy every visitor has its own
 * client address (X-Forwarded-For); without this, all E2E browsers share one per-IP bucket and
 * the API's abuse limits (20 workspace creations/min per IP, kept as-is) refuse the suite's own
 * bursts. The address is a stable TEST-NET-3 value derived from the test id.
 */
export const test = base.extend({
  // Playwright reads fixture dependencies from this destructuring pattern; `{}` = none.
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use, info) => {
    const n = createHash("sha256").update(info.testId).digest()[0]! % 250;
    await use({ "x-forwarded-for": `203.0.113.${n + 1}` });
  },
});
export { expect };

/** TEST_PLAN §10: the FIXTURE banner must be visible in every E2E test. */
export async function expectFixtureBanner(page: Page) {
  await expect(page.getByTestId("fixture-banner")).toHaveText(
    /FIXTURE — not real Qloo data/,
  );
}

/**
 * SECURITY §7: the CSP must not block anything the app needs. Browsers report violations
 * on the console ("Refused to …" / "Content Security Policy"); any such report fails the
 * test at its next accessibility check.
 */
const cspReports = new WeakMap<Page, string[]>();
export function watchCsp(page: Page) {
  if (cspReports.has(page)) return;
  const reports: string[] = [];
  cspReports.set(page, reports);
  page.on("console", (message) => {
    const text = message.text();
    if (
      /Content Security Policy|Refused to (execute|load|apply|connect|frame)/i.test(
        text,
      )
    )
      reports.push(text);
  });
}
export function expectNoCspViolations(page: Page) {
  expect(cspReports.get(page) ?? []).toEqual([]);
}

/** A11Y-01: zero serious or critical axe violations (and no CSP violations so far). */
export async function expectAccessible(page: Page, include?: string) {
  expectNoCspViolations(page);
  // Let colour transitions (150 ms) settle so contrast is measured on final colours.
  await page.waitForTimeout(400);
  let builder = new AxeBuilder({ page }).exclude(".react-flow__minimap");
  // A modal dims everything behind it; check what the user can actually reach.
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  const blocking = result.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(
    blocking.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

export async function snap(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
}

export async function createProject(page: Page, name: string) {
  watchCsp(page);
  await page.goto("/");
  await expectFixtureBanner(page);
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/brief$/);
}

export async function fillBrief(
  page: Page,
  brief: {
    title: string;
    challenge: string;
    interests: [string, string?][];
    locality?: string;
    capacity?: string;
  },
) {
  await page.getByLabel("Title").fill(brief.title);
  await page.getByLabel("Creative challenge").fill(brief.challenge);
  for (const [i, [text, world]] of brief.interests.entries()) {
    if (i >= 2)
      await page.getByRole("button", { name: "Add interest" }).click();
    await page.getByLabel(`Interest ${i + 1}`, { exact: true }).fill(text);
    if (world)
      await page.getByLabel(`World for interest ${i + 1}`).selectOption(world);
  }
  if (brief.locality)
    await page.getByLabel("Locality (optional)").fill(brief.locality);
  if (brief.capacity) await page.getByLabel("Capacity").fill(brief.capacity);
}

/** Typed multi-word titles resolve exactly on the synthetic transport (no H2 choice). */
export const TYPED_BRIEF = {
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

/** New project → H1 → discovery → pool committed → Hypothesis Lab paused at gate H3. */
export async function runToSelection(
  page: Page,
  name: string,
  useExample = false,
) {
  await createProject(page, name);
  if (useExample)
    await page.getByRole("button", { name: "Use the fixture example" }).click();
  else await fillBrief(page, TYPED_BRIEF);
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await page.getByRole("button", { name: "Confirm & discover" }).click();
  await page.getByRole("link", { name: "Open the Discovery canvas" }).click();
  await expect(page.getByText("Review the collision pool")).toBeVisible({
    timeout: 60_000,
  });
  const pool = page.getByRole("region", { name: "Collision pool" });
  await pool
    .getByRole("button", { name: "Generate hypotheses with this pool" })
    .click();
  // Navigating before the confirmation lands would abort the request.
  await expect(pool.getByText("The pool was committed")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Experiment steps" })
    .getByRole("link", { name: /Hypotheses/ })
    .click();
  await expect(
    page.getByRole("region", { name: "Select hypotheses" }),
  ).toBeVisible({ timeout: 90_000 });
  return page.url().replace(/\/hypotheses$/, "");
}
