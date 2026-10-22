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

test("M10-A cost safety UI: invite-only access notice, code redemption, and read-only samples", async ({
  page,
}) => {
  watchCsp(page);
  // The E2E server runs with RUN_ACCESS=open; the invite-mode API answers are simulated here
  // (the server-side policy itself is covered by tests/integration/m10a-cost-safety.test.ts).
  let redeemed = false;
  await page.route("**/api/v1/workspace/access", async (route) => {
    if (route.request().method() === "POST") {
      const { code } = route.request().postDataJSON() as { code: string };
      if (code !== "valid-demo-code-for-judges") {
        await route.fulfill({
          status: 400,
          json: {
            error: {
              code: "VALIDATION_FAILED",
              message: "This access code is not valid or no longer active.",
              retryable: false,
              requestId: "r",
              details: {},
            },
          },
        });
        return;
      }
      redeemed = true;
    }
    await route.fulfill({
      json: redeemed
        ? {
            access: "invite",
            allowed: true,
            grant: { label: "judge-1", expiresAt: "2026-11-30T00:00:00Z" },
          }
        : { access: "invite", allowed: false, grant: null },
    });
  });
  await page.route("**/api/v1/samples", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "01a16228-963b-71a2-a7eb-5e0b37e3f710",
            scope: "project",
            projectName: "Harbor Lights sample",
            useCase: "cafe",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  const notice = page.getByTestId("run-access");
  await expect(notice).toContainText(
    "AI runs on this demo need an access code",
  );
  const samples = page.getByTestId("demo-samples");
  await expect(
    samples.getByRole("link", { name: /Harbor Lights sample/ }),
  ).toHaveAttribute("href", "/samples/01a16228-963b-71a2-a7eb-5e0b37e3f710");
  await expectAccessible(page);

  await notice.getByLabel("Access code").fill("wrong-code-attempt");
  await notice.getByRole("button", { name: "Unlock AI runs" }).click();
  await expect(notice.getByRole("alert")).toHaveText(
    "This access code is not valid or no longer active.",
  );
  await notice.getByLabel("Access code").fill("valid-demo-code-for-judges");
  await notice.getByRole("button", { name: "Unlock AI runs" }).click();
  await expect(notice).toContainText("Demo access active (judge-1)");
  await expectAccessible(page);
});

test("M10-A: an unknown sample shows the inactive message (no workspace, no AI)", async ({
  page,
}) => {
  watchCsp(page);
  await page.goto("/samples/01a16228-963b-71a2-a7eb-5e0b37e3f710");
  await expect(page.getByText("This link is no longer active.")).toBeVisible();
  await expect(page.getByTestId("readonly-badge")).toHaveText(
    /Read-only demo sample/,
  );
  await expectAccessible(page);
});
