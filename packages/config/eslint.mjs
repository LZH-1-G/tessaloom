import { createRequire } from "node:module";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

// Resolve from the web workspace: pnpm does not hoist React to the repository root.
const webRequire = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const reactVersion = webRequire("react/package.json").version;

const internalPackages = ["core", "db", "agent", "qloo-adapter", "llm-gateway"];
function boundaries(allowed, pure = false) {
  const forbidden = internalPackages.filter((name) => !allowed.includes(name));
  return [
    "error",
    {
      patterns: [
        {
          group: forbidden.flatMap((name) => [
            `@tessaloom/${name}`,
            `@tessaloom/${name}/**`,
            `**/packages/${name}/**`,
            `**/${name}/src/**`,
          ]),
          message: "This import crosses an architecture module boundary.",
        },
        ...(pure
          ? [
              {
                group: [
                  "node:*",
                  "fs",
                  "fs/*",
                  "http",
                  "https",
                  "net",
                  "child_process",
                  "pg",
                  "drizzle-orm",
                  "drizzle-orm/*",
                  "react",
                  "react/*",
                ],
                message:
                  "Pure packages must not perform I/O or import UI code.",
              },
            ]
          : []),
      ],
    },
  ];
}

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/next-env.d.ts",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  ...[
    react.configs.flat.recommended,
    react.configs.flat["jsx-runtime"],
    reactHooks.configs.flat.recommended,
    jsxA11y.flatConfigs.recommended,
  ].map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx,js,mjs}"],
  })),
  {
    files: ["apps/web/**/*.{ts,tsx,js,mjs}"],
    settings: { react: { version: reactVersion } },
    rules: { "no-restricted-imports": boundaries(["core", "db"]) },
  },
  ...[
    ["core", []],
    ["db", ["core"]],
    ["agent", ["core"]],
    ["qloo-adapter", ["core", "db"]],
    ["llm-gateway", ["core"]],
  ].map(([name, allowed]) => ({
    files: [`packages/${name}/**/*.{ts,tsx,js,mjs}`],
    rules: {
      "no-restricted-imports": boundaries(
        allowed,
        name === "core" || name === "agent",
      ),
    },
  })),
  // Fixture firewall (ADR-014): live transports and the adapter core can never reach fixtures.
  {
    files: [
      "packages/qloo-adapter/src/adapter.ts",
      "packages/qloo-adapter/src/recorder.ts",
      "packages/qloo-adapter/src/transports/{cli,mcp,router}.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/fixture",
                "**/fixture.*",
                "./fixture",
                "../transports/fixture",
              ],
              message: "Live Qloo code must not import development fixtures.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/{core,agent}/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "fetch",
        "WebSocket",
        "XMLHttpRequest",
      ],
    },
  },
];
