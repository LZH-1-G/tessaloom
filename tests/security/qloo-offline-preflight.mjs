/** Configuration and dry-run audit only. Never prints credentials or raw doctor output. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const bin = realpathSync(process.argv[2] ?? "/opt/homebrew/bin/qloo");
const root = path.resolve(path.dirname(bin), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.name, "@qloo/qloo-harness");
assert.equal(pkg.version, "0.1.26");
const env = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "QLOO_HOME",
    "QLOO_API_KEY",
    "QLOO_BASE_URL",
    "QLOO_TRUSTED_BASE_URL",
  ]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
const deny = () => {
  throw new Error("Network forbidden during offline Qloo audit");
};
globalThis.fetch = deny;
const { resolveQlooPaths } = await import(
  pathToFileURL(path.join(root, "dist/paths.js")).href
);
const { resolveQlooClientConfiguration } = await import(
  pathToFileURL(path.join(root, "dist/chunks/chunk-ESNY4EJL.js")).href
);
const { runDoctor } = await import(
  pathToFileURL(path.join(root, "dist/doctor.js")).href
);
const paths = resolveQlooPaths({ env });
const config = resolveQlooClientConfiguration({
  env,
  configPath: paths.configFile,
});
const safeUrl = (v) => {
  try {
    const u = new URL(v);
    return !u.username && !u.password && !u.search && !u.hash
      ? u.origin + u.pathname
      : "redacted-invalid-endpoint";
  } catch {
    return null;
  }
};
const eventEnv = {
  ...env,
  QLOO_BASE_URL: "https://hackathon.api.qloo.com",
  QLOO_TRUSTED_BASE_URL: "https://hackathon.api.qloo.com",
};
const doctor = await runDoctor({
  env: eventEnv,
  paths,
  network: false,
  networkProbe: deny,
  resolverNetworkProbe: deny,
});
const stat = lstatSync(paths.configFile);
assert(!stat.isSymbolicLink());
assert.equal(stat.mode & 0o777, 0o600);
assert.equal(stat.uid, process.getuid());
const dir = mkdtempSync(path.join(tmpdir(), "tessaloom-qloo-offline-"));
try {
  const preload = path.join(dir, "deny-network.mjs");
  writeFileSync(
    preload,
    "import net from 'node:net'; const deny=()=>{throw new Error('OFFLINE_NETWORK_DENIED')}; globalThis.fetch=deny; net.Socket.prototype.connect=deny;",
    { mode: 0o600 },
  );
  const commands = [
    ["search", "--query", "The Beatles", "--type", "artist", "--take", "2"],
    ["search", "--query", "Spirited Away", "--type", "movie", "--take", "2"],
    [
      "insights",
      "--type",
      "book",
      "--signal-entities",
      "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
      "--take",
      "1",
    ],
  ];
  const dryRuns = commands.map((args) => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", preload, bin, "api", ...args, "--dry-run", "--json"],
        {
          env: eventEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        },
      ),
    );
    return {
      method: result.method,
      reportedUrl: safeUrl(result.url),
      params: result.params,
    };
  });
  console.log(
    JSON.stringify(
      {
        harnessVersion: pkg.version,
        credentialConfigured: Boolean(config.apiKey),
        credentialSource: config.apiKeySource,
        configMode: "600",
        configOwnedByCurrentUser: true,
        shellEndpointConfigured: Boolean(env.QLOO_BASE_URL),
        defaultResolvedEndpoint: safeUrl(
          config.baseUrl ?? "https://api.qloo.com",
        ),
        explicitEventEndpoint: "https://hackathon.api.qloo.com",
        offlineDoctor: doctor.checks
          .filter((c) => ["qloo-auth", "qloo-endpoint-trust"].includes(c.id))
          .map((c) => ({ id: c.id, status: c.status })),
        dryRuns,
        insightsIdsAreSyntheticPlaceholders: true,
        dryRunUrlIsNotEndpointTrustEvidence: true,
        httpRequests: 0,
        credentialIssuerQuotaExpiryAndSharingVerified: false,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("Offline Qloo audit failed; raw subprocess output suppressed.");
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
