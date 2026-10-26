import {
  createProject,
  expectAccessible,
  expectFixtureBanner,
  fillBrief,
  snap,
  expect,
  test,
} from "./helpers";

// Live Qloo data can return too few cross-world bridges (observed 2026-10-26: POOL_TOO_SMALL).
// The synthetic catalog always overlaps, so this test runs the real fixture journey to the
// pool gate and then presents that same run as stopped with POOL_TOO_SMALL. It checks the
// guidance UI only; it is not a claim about any live run.
const BRIEF = {
  title: "Quiet bridges",
  challenge:
    "A 40-seat café wants a monthly evening for game and book fans who rarely meet.",
  interests: [
    ["Stardew Harvest Tales", "videogame"],
    ["Paper Atlas Stories", "book"],
  ] as [string, string?][],
  capacity: "40",
};

test("Discovery explains an insufficient collision pool and points back to the brief", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await createProject(page, "Quiet bridges");
  const projectId = /\/projects\/([0-9a-f-]+)\//.exec(page.url())![1]!;
  await fillBrief(page, BRIEF);
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await page.getByRole("button", { name: "Confirm & discover" }).click();
  await page.getByRole("link", { name: "Open the Discovery canvas" }).click();
  await expect(page.getByText("Review the collision pool")).toBeVisible({
    timeout: 60_000,
  });

  await page.route("**/api/v1/experiments/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.runs) && body.runs[0])
      body.runs[0] = {
        ...body.runs[0],
        state: "FAILED",
        terminalReason: "POOL_TOO_SMALL",
        pendingConfirmation: null,
      };
    await route.fulfill({ response, json: body });
  });
  await page.reload();

  const panel = page.getByRole("region", {
    name: "Not enough cultural bridges to build hypotheses",
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("different worlds");
  await expect(panel).toContainText(/thread results across \d+ worlds?/);
  await expect(panel).toContainText("Add a third interest");
  // The stopped run no longer offers the pool gate.
  await expect(page.getByText("Review the collision pool")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "Not enough cultural bridges" }),
  ).toBeVisible();
  await expectFixtureBanner(page);
  await expectAccessible(page);
  await snap(page, info, "discovery-insufficient");

  await panel
    .getByRole("link", { name: "Revise the brief and try again" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/brief$`));
});
