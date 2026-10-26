import { randomBytes } from "node:crypto";
import { createDb } from "./client";
import {
  createDemoGrant,
  globalLlmSpendToday,
  hashDemoCode,
  listDemoGrants,
  revokeDemoGrant,
} from "./repositories/cost";
import { listSamples, setSampleFeatured } from "./repositories/blueprint";
import { acceptanceReport } from "./repositories/ops";

/**
 * Operator CLI (bundled to dist/admin.mjs; M10-A cost safety). It never deletes data, never
 * runs automatically, and prints an access code only once, at creation. It needs the same
 * DATABASE_URL and SHARE_TOKEN_PEPPER as the web process.
 *
 *   node packages/db/dist/admin.mjs grant create --label judge-1 --days 14 --runs 10 --usd 5
 *   node packages/db/dist/admin.mjs grant list
 *   node packages/db/dist/admin.mjs grant revoke <grantId>
 *   node packages/db/dist/admin.mjs sample feature|unfeature <shareLinkId>
 *   node packages/db/dist/admin.mjs sample list
 *   node packages/db/dist/admin.mjs spend today
 *   node packages/db/dist/admin.mjs report project <projectId>   (acceptance evidence, metadata only)
 */
const USAGE =
  "usage: admin.mjs grant create --label L [--days 14] [--runs 10] [--usd 5] | grant list | grant revoke <id> | sample feature|unfeature|list [<shareLinkId>] | spend today | report project <projectId>";

class AdminInputError extends Error {}

const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function flag(args: string[], name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : fallback;
  if (value === undefined) throw new AdminInputError(`Missing --${name}`);
  return value;
}

function positiveNumber(value: string, name: string, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new AdminInputError(`--${name} must be between 0 and ${max}`);
  return n;
}

async function main(argv: string[]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new AdminInputError("DATABASE_URL is required");
  const [area, action, ...rest] = argv;
  const handle = createDb(url, { max: 1, applicationName: "tessaloom-admin" });
  try {
    if (area === "grant" && action === "create") {
      const pepper = process.env.SHARE_TOKEN_PEPPER;
      if (!pepper || pepper.length < 32)
        throw new AdminInputError(
          "SHARE_TOKEN_PEPPER (as used by the web process) is required",
        );
      const label = flag(rest, "label");
      const days = positiveNumber(flag(rest, "days", "14"), "days", 90);
      const code = randomBytes(24).toString("base64url");
      const grant = await createDemoGrant(handle.db, {
        label,
        codeHash: hashDemoCode(code, pepper),
        expiresAt: new Date(Date.now() + days * 86_400_000),
        maxRuns: Math.floor(
          positiveNumber(flag(rest, "runs", "10"), "runs", 500),
        ),
        maxLlmUsd: positiveNumber(flag(rest, "usd", "5"), "usd", 100),
      });
      out({
        grantId: grant.id,
        label: grant.label,
        expiresAt: grant.expiresAt,
        maxRuns: grant.maxRuns,
        maxLlmUsd: grant.maxLlmUsdMicros / 1_000_000,
        code,
        note: "Shown once. Only a hash is stored; revoke with: grant revoke <grantId>",
      });
    } else if (area === "grant" && action === "list") {
      out(await listDemoGrants(handle.db));
    } else if (area === "grant" && action === "revoke" && rest[0]) {
      out({ revoked: await revokeDemoGrant(handle.db, rest[0]) });
    } else if (
      area === "sample" &&
      (action === "feature" || action === "unfeature") &&
      rest[0]
    ) {
      out({
        updated: await setSampleFeatured(
          handle.db,
          rest[0],
          action === "feature",
        ),
      });
    } else if (area === "sample" && action === "list") {
      out(await listSamples(handle.db));
    } else if (area === "spend" && action === "today") {
      out({ globalLlmUsdToday: await globalLlmSpendToday(handle.db) });
    } else if (area === "report" && action === "project" && rest[0]) {
      const report = await acceptanceReport(handle.db, rest[0]);
      if (!report) throw new AdminInputError("Project not found");
      out(report);
    } else {
      throw new AdminInputError(USAGE);
    }
  } finally {
    await handle.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Never print connection strings or secrets: only the message of our own validation errors.
  const message =
    error instanceof AdminInputError
      ? error.message
      : "Database or operation failed";
  console.error(
    JSON.stringify({
      event: "admin_failed",
      message,
    }),
  );
  process.exit(1);
});
