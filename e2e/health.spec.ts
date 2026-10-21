import { expect, test } from "@playwright/test";
import { expectAccessible, expectFixtureBanner, snap } from "./helpers";

test("liveness, readiness with the worker heartbeat, and the studio dashboard", async ({
  request,
  page,
}, info) => {
  const live = await request.get("/api/health");
  expect(live.status()).toBe(200);
  const ready = await request.get("/api/health/ready");
  expect(await ready.json()).toEqual({ db: true, worker: true });
  await page.goto("/");
  await expectFixtureBanner(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /Where different worlds create new possibilities/,
  );
  await expect(page.getByTestId("mode-badge")).toHaveText("fixture");
  await expect(page.getByText("An empty loom.")).toBeVisible();
  // The browser kept both workspace cookies (Linux WebKit drops Secure cookies over HTTP).
  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(["tl_ws", "tl_csrf"]));
  await expectAccessible(page);
  await snap(page, info, "dashboard");
});
