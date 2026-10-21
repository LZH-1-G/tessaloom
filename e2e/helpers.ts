import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

/** TEST_PLAN §10: the FIXTURE banner must be visible in every E2E test. */
export async function expectFixtureBanner(page: Page) {
  await expect(page.getByTestId("fixture-banner")).toHaveText(
    /Development fixtures — not real Qloo data/,
  );
}

/** A11Y-01: zero serious or critical axe violations. */
export async function expectAccessible(page: Page, include?: string) {
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
