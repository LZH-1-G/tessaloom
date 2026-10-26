#!/usr/bin/env node
// External smoke test for the public Tessaloom URL (run from outside the platform after the
// port is made public). Read-only by default. `--write-probe` additionally creates one
// anonymous workspace, project and brief and checks that starting a run is refused without
// any model or Qloo call. It never uses an access code or a key.
//
//   node deploy/public-smoke.mjs https://p01--tessaloom--<id>.code.run [--write-probe] [--local]
//
// `--local` relaxes HTTPS-only expectations (HSTS) for a local HTTP rehearsal.
import assert from "node:assert/strict";

const [base, ...flags] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base))
  throw new Error(
    "usage: public-smoke.mjs <base-url> [--write-probe] [--local]",
  );
const local = flags.includes("--local");
const writeProbe = flags.includes("--write-probe");
const origin = new URL(base).origin;
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ check: name, ok: true });
  } catch (error) {
    results.push({
      check: name,
      ok: false,
      error: error.message.slice(0, 200),
    });
  }
};
const get = (path, init = {}) =>
  fetch(new URL(path, origin), { redirect: "manual", ...init });

await check("home page is served with security headers", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /nonce-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  if (!local)
    assert.match(
      res.headers.get("strict-transport-security") ?? "",
      /max-age=/,
    );
  assert.equal(res.headers.get("x-powered-by"), null);
});

await check("readiness is healthy and reveals only booleans", async () => {
  const res = await get("/api/health/ready");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), ["db", "worker"]);
});

await check(
  "status: worker online, Qloo ready, generation state reported",
  async () => {
    const status = await (await get("/api/v1/system/status")).json();
    assert.equal(status.workerOnline, true);
    assert.equal(status.qlooReady, true);
    assert.ok("llmConfigured" in status, "status lacks llmConfigured");
    if (status.llmConfigured === false) assert.equal(status.llmModel, null);
    assert.ok(!JSON.stringify(status).match(/key|secret|token|password/i));
  },
);

await check(
  "samples list is public and carries no fixtures in production",
  async () => {
    const res = await get("/api/v1/samples", { credentials: "omit" });
    assert.equal(res.status, 200);
    const { items } = await res.json();
    if (!local) assert.ok(items.every((i) => !i.fixture));
    for (const item of items.slice(0, 3)) {
      const sample = await get(`/api/v1/samples/${item.id}`);
      assert.equal(sample.status, 200);
      const text = await sample.text();
      assert.doesNotMatch(
        text,
        /"(workspaceId|qlooId|popularity|affinity|snapshot|toolInvocationId|costUsd)":/,
      );
    }
  },
);

await check(
  "unknown samples and share tokens answer a constant 404",
  async () => {
    const s = await get("/api/v1/samples/00000000-0000-7000-8000-000000000000");
    assert.equal(s.status, 404);
    const t = await get(`/api/v1/share/${"A".repeat(43)}`);
    assert.equal(t.status, 404);
    assert.match(await t.text(), /no longer active/);
  },
);

await check(
  "private data needs a workspace; admin-like paths do not exist",
  async () => {
    const projects = await get("/api/v1/projects", { credentials: "omit" });
    assert.ok(
      [401, 403].includes(projects.status),
      `projects: ${projects.status}`,
    );
    for (const path of [
      "/admin",
      "/api/admin",
      "/api/v1/admin",
      "/.env",
      "/package.json",
      "/apps/worker/dist/main.js",
    ]) {
      const res = await get(path);
      assert.ok([404, 405].includes(res.status), `${path}: ${res.status}`);
    }
  },
);

await check("mutations without CSRF and Origin are refused", async () => {
  const res = await get("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "smoke", useCase: "cafe" }),
  });
  assert.ok([401, 403].includes(res.status), `status ${res.status}`);
});

if (writeProbe)
  await check(
    "an anonymous run start is refused before any model or Qloo call",
    async () => {
      const jar = new Map();
      const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const remember = (res) => {
        for (const c of res.headers.getSetCookie?.() ?? []) {
          const [pair] = c.split(";");
          const i = pair.indexOf("=");
          jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
      };
      remember(await get("/api/v1/workspace"));
      const csrf = decodeURIComponent(jar.get("tl_csrf") ?? "");
      const post = async (path, body) => {
        const res = await get(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: cookies(),
            origin,
            "x-tessaloom-csrf": csrf,
          },
          body: JSON.stringify(body),
        });
        remember(res);
        return res;
      };
      const project = await (
        await post("/api/v1/projects", { name: "Smoke probe", useCase: "cafe" })
      ).json();
      const brief = await (
        await post(`/api/v1/projects/${project.id}/briefs`, {
          title: "Smoke probe",
          challenge: "A small café wants a quiet weeknight event.",
          interests: [{ text: "Spirited Away" }, { text: "Joe Hisaishi" }],
          venue: { type: "cafe", capacity: 20 },
          goals: ["Check that paid runs are refused"],
        })
      ).json();
      const start = await post(`/api/v1/projects/${project.id}/experiments`, {
        briefVersionId: brief.id,
        mode: "live",
      });
      assert.ok(
        [403, 503].includes(start.status),
        `run start: ${start.status}`,
      );
      const code = (await start.json()).error?.code;
      assert.ok(
        ["PAID_RUNS_DISABLED", "RUN_ACCESS_REQUIRED"].includes(code),
        code,
      );
    },
  );

console.log(JSON.stringify({ base: origin, results }, null, 2));
if (results.some((r) => !r.ok)) process.exitCode = 1;
