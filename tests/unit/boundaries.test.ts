import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

it.each([
  ["no-undef", "process.exit(missingExitCode);"],
  ["no-unreachable", "function run() { return; process.exit(1); } run();"],
  ["no-dupe-keys", "export const settings = { uid: 10001, uid: 0 };"],
  ["no-constant-condition", "if (false) process.exit(1);"],
])("checks JavaScript scripts with %s", async (ruleId, code) => {
  const results = await new ESLint().lintText(code, {
    filePath: "scripts/lint-probe.mjs",
  });
  expect(results[0]?.messages.some((item) => item.ruleId === ruleId)).toBe(
    true,
  );
});

it("allows Node built-ins in JavaScript scripts", async () => {
  const results = await new ESLint().lintText("console.log(process.pid);", {
    filePath: "scripts/lint-probe.mjs",
  });
  expect(results[0]?.messages).toEqual([]);
});

it("resolves the React version from the web workspace", async () => {
  const webRequire = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const config = await new ESLint().calculateConfigForFile(
    "apps/web/src/app/page.tsx",
  );
  expect(config.settings.react.version).toBe(
    webRequire("react/package.json").version,
  );
});

it.each([
  ["@typescript-eslint/no-explicit-any", "export const value: any = 1;"],
  [
    "react/jsx-key",
    "export const View = () => [1].map(n => <span>{n}</span>);",
  ],
  ["jsx-a11y/alt-text", 'export const View = () => <img src="/image.png" />;'],
  [
    "react-hooks/rules-of-hooks",
    'import { useState } from "react"; export function View({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }',
  ],
])("retains the %s lint guard", async (ruleId, code) => {
  const results = await new ESLint().lintText(code, {
    filePath: "apps/web/src/lint-probe.tsx",
  });
  expect(results[0]?.messages.some((item) => item.ruleId === ruleId)).toBe(
    true,
  );
});

it.each([
  ["apps/web/src/forbidden.ts", "@tessaloom/qloo-adapter"],
  ["apps/web/src/forbidden.ts", "@tessaloom/llm-gateway/provider"],
  ["apps/web/src/forbidden.ts", "../../../packages/qloo-adapter/src/index"],
  ["packages/agent/src/forbidden.ts", "@tessaloom/db"],
  ["packages/core/src/forbidden.ts", "node:fs"],
])("enforces the boundary in %s for %s", async (filePath, source) => {
  const eslint = new ESLint();
  const results = await eslint.lintText(`export * from "${source}";\n`, {
    filePath,
  });
  expect(
    results[0]?.messages.some(
      (item) => item.ruleId === "no-restricted-imports",
    ),
  ).toBe(true);
});

it("allows the documented agent → core dependency", async () => {
  const results = await new ESLint().lintText(
    'export * from "@tessaloom/core";\n',
    {
      filePath: "packages/agent/src/allowed.ts",
    },
  );
  expect(results[0]?.errorCount).toBe(0);
});
