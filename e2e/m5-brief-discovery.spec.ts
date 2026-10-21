import { expect, test } from "@playwright/test";
import {
  createProject,
  expectAccessible,
  expectFixtureBanner,
  fillBrief,
  snap,
} from "./helpers";

const BRIEF = {
  title: "Low-Fi Lounge weeknights",
  challenge:
    "A 35-seat café wants a recurring weekday evening for a creative, budget-conscious crowd.",
  interests: [["cumbia"], ["Stardew Harvest Tales", "videogame"]] as [
    string,
    string?,
  ][],
  locality: "Lisbon",
  capacity: "35",
};

test("E2E-02: new project → brief validation → H1 with editable intent chips", async ({
  page,
}, info) => {
  await createProject(page, "Low-Fi Lounge");
  await expectFixtureBanner(page);
  // Validation: fewer than two interests.
  await page.getByLabel("Title").fill("Half a brief");
  await page.getByLabel("Creative challenge").fill("Too short");
  await page.getByLabel("Interest 1", { exact: true }).fill("cumbia");
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await expect(
    page.getByText("Add at least two interests from different worlds."),
  ).toBeVisible();
  await expect(
    page.getByText("Describe the challenge in at least 20 characters."),
  ).toBeVisible();
  await expect(page.getByLabel("Creative challenge")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expectAccessible(page);

  await fillBrief(page, BRIEF);
  await expect(page.getByLabel("Preview")).toContainText(
    "Low-Fi Lounge weeknights",
  );
  await page.getByRole("button", { name: "Interpret brief" }).click();

  const h1 = page.getByRole("region", {
    name: "Did we read your brief right?",
  });
  await expect(h1).toBeVisible();
  await expect(h1.getByText("AI interpretation")).toBeVisible();
  await expect(page.getByText(/Needs your input/)).toBeVisible();
  // The intent chips are editable: change the guessed world of "cumbia".
  const world = page.getByLabel("World for cumbia");
  await expect(world).toHaveValue("unknown");
  await world.selectOption("artist");
  await expect(h1.getByText("1 world change will be applied")).toBeVisible();
  await expectAccessible(page);
  await snap(page, info, "brief-h1");
  await world.selectOption("unknown");
  await h1.getByRole("button", { name: "Confirm & discover" }).click();
  await expect(page.getByText("Brief confirmed")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the Discovery canvas" }),
  ).toBeVisible();
});

test("E2E-03 + E2E-04: H2 candidates (refine, exclude, pick) → discovery canvas and list view", async ({
  page,
}, info) => {
  await createProject(page, "Low-Fi Lounge H2");
  await fillBrief(page, BRIEF);
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await page.getByRole("button", { name: "Confirm & discover" }).click();
  await page.getByRole("link", { name: "Open the Discovery canvas" }).click();

  const h2 = page.getByRole("region", { name: "Which ones did you mean?" });
  await expect(h2).toBeVisible();
  const cumbia = page.getByTestId("h2-row-0");
  const lisbon = page.getByTestId("h2-row-2");
  // CI-A1: nothing is pre-selected for an ambiguous interest.
  await expect(cumbia.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(cumbia.getByText("Tag", { exact: true }).first()).toBeVisible();
  // V1: localities carry search disambiguation.
  await expect(lisbon).toContainText("Fictional Province, Testland");
  await expectAccessible(page);
  await snap(page, info, "discovery-h2");

  // Refine re-runs resolution for that interest.
  await cumbia.getByLabel("Refine").check();
  await page
    .getByLabel("Refined search text for cumbia")
    .fill("cumbia sonidera");
  await lisbon.getByLabel("Exclude").check();
  await page.getByRole("button", { name: "Confirm choices" }).click();
  const refined = page.getByTestId("h2-row-0");
  await expect(refined).toContainText("cumbia sonidera");
  await refined
    .getByRole("radio", { name: /Use cumbia sonidera, tag/ })
    .first()
    .check();
  await page.getByRole("button", { name: "Confirm choices" }).click();

  // E2E-04: lanes render; the list view carries the same threads. The run keeps working
  // after discovery, so wait until it pauses at its next gate before interacting.
  await expect(
    page.getByText(
      /Review the collision pool|Select hypotheses to carry forward/,
    ),
  ).toBeVisible({ timeout: 60_000 });
  const canvas = page.getByTestId("discovery-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.getByText(/^Video game/)).toBeVisible();
  await expect(canvas.getByText(/^Book/)).toBeVisible();
  await expect(
    page.getByText("Lisbon", { exact: false }).first(),
  ).toBeVisible();
  await expectFixtureBanner(page);
  await snap(page, info, "discovery-canvas");

  // Select a node with the keyboard (focus + Enter) → inspector with provenance and a Trace.
  const node = canvas
    .locator(".react-flow__node-entity")
    .filter({ hasText: "#1" })
    .first();
  await node.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByLabel(/^Inspector/);
  await expect(inspector.first()).toContainText("FIXTURE — not Qloo data");
  await inspector.first().getByRole("button", { name: "Trace" }).click();
  const trace = page.getByRole("dialog", { name: "Trace: request to result" });
  await expect(trace.getByTestId("trace-envelope")).toContainText("ok");
  await expect(trace.getByTestId("trace-args")).toContainText("target");
  await expectAccessible(page, "dialog[open]");
  await trace.getByRole("button", { name: "Close trace" }).click();

  await page.getByRole("button", { name: "List" }).click();
  const list = page.getByTestId("discovery-list");
  await expect(list.getByRole("heading", { level: 3 }).first()).toBeVisible();
  expect(await list.getByTestId("list-item").count()).toBeGreaterThan(10);
  await expectAccessible(page);
});
