import {
  expect,
  expectAccessible,
  expectFixtureBanner,
  test,
  watchCsp,
} from "./helpers";

// Public demo: with TRUSTED_PROXY_HOPS=0 every visitor shares one workspace-creation bucket,
// so a burst of new visitors can get 429 there. System status is public and must not depend on
// that bootstrap (it previously read "Qloo unavailable"), and the error must be readable.
test("system status stays truthful and the message is readable when workspace creation is throttled", async ({
  page,
}) => {
  watchCsp(page);
  await page.route("**/api/v1/workspace", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Too many requests." },
      }),
    }),
  );
  await page.goto("/");
  await expectFixtureBanner(page);
  await expect(page.getByText("Qloo ready").first()).toBeVisible();
  await expect(page.getByText("Agent worker: online")).toBeVisible();
  await expect(page.getByText(/Lots of new visitors right now/)).toBeVisible();
  await expect(page.getByText(/Load failed|Failed to fetch/)).toHaveCount(0);
  await expectAccessible(page);
});
