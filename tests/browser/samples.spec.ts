import pg from "pg";
import {
  expect,
  test,
  expectAccessible,
  expectFixtureBanner,
  watchCsp,
  snap,
} from "../../e2e/helpers";

test("prepared fixture samples are usable without generation or a workspace", async ({
  page,
}, info) => {
  const db = new pg.Client({
    connectionString: process.env.E2E_SAMPLE_DATABASE_URL,
  });
  await db.connect();
  const counts = async () =>
    (
      await db.query(
        "SELECT (SELECT count(*) FROM agent_runs)::int runs, (SELECT count(*) FROM llm_spend_reservations)::int reservations",
      )
    ).rows[0];
  try {
    const before = await counts();
    watchCsp(page);
    const response = await page.request.get("/api/v1/samples");
    expect(response.status()).toBe(200);
    const { items } = (await response.json()) as {
      items: { id: string; scope: string }[];
    };
    expect(items).toHaveLength(2);
    // Direct visitors do not need an owner session or an invitation.
    for (const sample of items) {
      await page.goto(`/samples/${sample.id}`);
      await expect(page.getByTestId("readonly-badge")).toContainText(
        "Read-only demo sample",
      );
      await expectFixtureBanner(page);
      if (sample.scope === "project") {
        // Project samples tell the whole read-only story, not just counts.
        for (const heading of [
          "The creative brief",
          "Interests confirmed with Qloo",
          "Discovery across cultural worlds",
          "Hypotheses tested against Qloo evidence",
          "What this does not show",
        ])
          await expect(
            page.getByRole("heading", { name: heading }),
          ).toBeVisible();
        await expect(page.getByText("Chosen for the blueprint")).toBeVisible();
        await expect(page.getByTestId("evidence-appendix")).toContainText(
          "E-1",
        );
        await expect(
          page.getByRole("region", { name: "What this does not show" }),
        ).toContainText("labelled synthetic fixtures, not Qloo data");
      }
      if (sample.scope === "blueprint") {
        await expect(page.getByTestId("traceability-meter")).toContainText(
          "evidence-backed",
        );
        await expect(page.getByTestId("evidence-appendix")).toContainText(
          "E-1",
        );
      }
      await expect(
        page.getByRole("button", { name: /^Edit|^Compose|^Accept|^Share/ }),
      ).toHaveCount(0);
      await expectAccessible(page);
      await snap(page, info, `sample-${sample.scope}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await expectAccessible(page);
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toBe(true);
      await snap(page, info, `sample-${sample.scope}-mobile`);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.goto("/");
    await expect(page.getByTestId("run-access")).toContainText("paused");
    await expect(
      page.getByTestId("demo-samples").getByRole("link"),
    ).toHaveCount(2);
    await expectAccessible(page);
    expect(await counts()).toEqual(before);
  } finally {
    await db.end();
  }
});
