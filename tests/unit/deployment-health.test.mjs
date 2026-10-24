import { beforeAll, afterAll, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { healthOrigin, probeHealth } from "../../deploy/health.mjs";

let folder, server, origin, ca;
let mode = "healthy";
const paths = [];
beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), "tl-health-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { cwd: folder, stdio: "ignore" },
  );
  ca = readFileSync(path.join(folder, "cert.pem"));
  server = https.createServer(
    { key: readFileSync(path.join(folder, "key.pem")), cert: ca },
    (req, res) => {
      paths.push(req.url);
      if (mode === "stall") return;
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
      res.setHeader("Cache-Control", "no-store");
      if (mode === "redirect") {
        res.writeHead(302, { location: "/never-follow" });
        res.end();
        return;
      }
      if (mode === "large") {
        res.end("x".repeat(17000));
        return;
      }
      if (mode === "cached")
        res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(
        JSON.stringify(
          req.url.endsWith("/ready")
            ? { db: true, worker: mode !== "unready" }
            : { status: "ok" },
        ),
      );
    },
  );
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  origin = `https://localhost:${server.address().port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (folder) rmSync(folder, { recursive: true, force: true });
});

it("rejects credentials, token-bearing URLs and non-HTTPS origins", () => {
  for (const value of [
    "http://localhost",
    "https://u:p@localhost",
    "https://localhost/share/token",
    "https://localhost?key=x",
    "https://localhost/#x",
  ])
    expect(() => healthOrigin(value)).toThrow();
});
it("verifies TLS and checks only liveness/readiness without touching providers", async () => {
  mode = "healthy";
  paths.length = 0;
  expect((await probeHealth(origin, { ca })).ok).toBe(true);
  expect(paths).toEqual(["/api/health", "/api/health/ready"]);
  expect((await probeHealth(origin)).ok).toBe(false);
});
it("rejects stale readiness, caching, redirects and oversized responses", async () => {
  for (const failure of ["unready", "cached", "redirect", "large"]) {
    mode = failure;
    expect((await probeHealth(origin, { ca })).ok).toBe(false);
  }
  expect(paths).not.toContain("/never-follow");
});
it("bounds a peer that connects but never responds", async () => {
  mode = "stall";
  const start = Date.now();
  expect((await probeHealth(origin, { ca, timeoutMs: 60 })).ok).toBe(false);
  expect(Date.now() - start).toBeLessThan(2000);
});
