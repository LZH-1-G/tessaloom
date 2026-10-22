import {
  createProject,
  expectAccessible,
  expectFixtureBanner,
  expectNoCspViolations,
  watchCsp,
  expect,
  test,
} from "./helpers";

const XSS = `<img src=x onerror=alert(1)>`;

test("SECURITY §7: CSP with a per-request nonce and security headers on pages, API, and share pages", async ({
  page,
  request,
}) => {
  watchCsp(page);
  const first = await page.goto("/");
  const csp = first!.headers()["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  // Local HTTP test server: no HSTS, no upgrade to HTTPS (HTTPS environments get both).
  expect(first!.headers()["strict-transport-security"]).toBeUndefined();
  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(first!.headers()["x-frame-options"]).toBe("DENY");
  expect(first!.headers()["x-content-type-options"]).toBe("nosniff");
  // The app hydrates and runs under the policy.
  await expectFixtureBanner(page);
  await expect(page.getByTestId("mode-badge")).toHaveText("fixture");

  const second = await page.reload();
  const nonce = (h: string) => /'nonce-([^']+)'/.exec(h)![1];
  expect(nonce(second!.headers()["content-security-policy"]!)).not.toBe(
    nonce(csp),
  );

  const api = await request.get("/api/v1/system/status");
  expect(api.headers()["content-security-policy"]).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(api.headers()["x-content-type-options"]).toBe("nosniff");
  const share = await page.goto(
    "/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  expect(share!.headers()["referrer-policy"]).toBe("no-referrer");
  expect(share!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.getByText("This link is no longer active.")).toBeVisible();
  expectNoCspViolations(page);
});

test("TEST_PLAN §9 XSS: markup in a project name and brief title renders as text", async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await createProject(page, `XSS ${XSS}`);
  await expect(page.getByTestId("project-name")).toHaveText(`XSS ${XSS}`);
  await page.getByLabel("Title").fill(XSS);
  await page.getByLabel("Creative challenge").fill(`A challenge ${XSS}`);
  await page
    .getByLabel("Interest 1", { exact: true })
    .fill("Stardew Harvest Tales");
  await page
    .getByLabel("Interest 2", { exact: true })
    .fill("Paper Atlas Stories");
  await page.getByRole("button", { name: "Interpret brief" }).click();
  await expect(page.getByText(`A challenge ${XSS}`).first()).toBeVisible();
  await page.goto("/");
  await expect(page.getByText(`XSS ${XSS}`).first()).toBeVisible();
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(dialogs).toEqual([]);
  await expectAccessible(page);
});

test("SECURITY §7: injected markup without the nonce cannot run (stored-XSS simulation)", async ({
  page,
}) => {
  const reports: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      reports.push(m.text());
  });
  // Rewrite the document in transit, keeping the real CSP header: a parser-inserted inline
  // script, an inline event handler, and a third-party script must all be refused.
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "</body>",
      `<script>window.__inline=1</script><img src="/missing.png" onerror="window.__onerror=1"><script src="https://example.com/x.js"></script></body>`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await expectFixtureBanner(page); // the app's own nonce-tagged scripts still run
  await expect.poll(() => reports.length).toBeGreaterThanOrEqual(2);
  const ran = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { inline: w.__inline, onerror: w.__onerror };
  });
  expect(ran).toEqual({ inline: undefined, onerror: undefined });
});
