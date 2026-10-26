#!/usr/bin/env node
// Desktop and mobile render check for the public URL that writes nothing to the database: the
// browser is blocked from the calls that create an anonymous workspace or project, so the
// studio renders exactly as a first visit would, without a production record.
//
//   node deploy/public-render-check.mjs <base-url> [out-dir]
import { chromium, webkit } from "@playwright/test";

const [base, out = "."] = process.argv.slice(2);
if (!base)
  throw new Error("usage: public-render-check.mjs <base-url> [out-dir]");
const BLOCKED = /\/api\/v1\/(workspace|projects)(\/|$|\?)/;
const results = [];
for (const [engine, launcher] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await launcher.launch();
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    const writes = [];
    const errors = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text()))
        errors.push(m.text().slice(0, 160));
    });
    await page.route("**/api/v1/**", (route) => {
      if (BLOCKED.test(route.request().url())) {
        writes.push(
          route.request().method() +
            " " +
            new URL(route.request().url()).pathname,
        );
        return route.abort();
      }
      return route.continue();
    });
    const res = await page.goto(base, { waitUntil: "networkidle" });
    const heading = await page
      .getByRole("heading", { level: 1 })
      .first()
      .textContent();
    // Evaluated in the page, so pass it as a string (no browser globals in this Node file).
    const overflow = await page.evaluate(
      "document.documentElement.scrollWidth - window.innerWidth",
    );
    const file = `${out}/public-${engine}-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    results.push({
      engine,
      viewport: name,
      status: res?.status(),
      heading: heading?.trim(),
      horizontalOverflowPx: overflow,
      cspViolations: errors.length,
      blockedWorkspaceCalls: writes.length,
      screenshot: file,
    });
    await page.close();
  }
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (
  results.some(
    (r) => r.status !== 200 || r.horizontalOverflowPx > 0 || r.cspViolations,
  )
)
  process.exitCode = 1;
