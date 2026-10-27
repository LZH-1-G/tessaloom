import { createProject, expect, test } from "./helpers";

// The step rail scrolls horizontally on phones. Its grid cell once kept `min-width: auto`, so the
// single grid column grew to the rail's full width (481 px) and every project page scrolled
// sideways by ~107 px at 390 px. Locked steps also leaked their absolutely positioned sr-only notes
// outside the scroller (+29 px).
test("project pages fit a 390 px phone without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, "Phone layout check");
  const base = page.url().replace(/\/brief$/, "");
  for (const step of [
    "brief",
    "discovery",
    "hypotheses",
    "what-if",
    "blueprint",
  ]) {
    await page.goto(`${base}/${step}`);
    await expect(page.locator("main#main")).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
        { message: `${step} overflows horizontally` },
      )
      .toBeLessThanOrEqual(0);
  }
  await expect(
    page.getByRole("navigation", { name: "Experiment steps" }),
  ).toBeVisible();
});
