import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("M0 liveness and placeholder page", async ({
  request,
  page,
}, testInfo) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", version: "0.0.0" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Tessaloom", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The studio is taking shape.")).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("m0-placeholder.png"),
    fullPage: true,
  });
});
