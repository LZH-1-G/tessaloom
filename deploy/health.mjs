import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Read-only probe: never calls a provider, creates a workspace or follows redirects.
export function healthOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Expected an HTTPS origin without credentials, path or query",
    );
  return url;
}

export async function probeHealth(value, { ca, timeoutMs = 10000 } = {}) {
  const origin = healthOrigin(value);
  const checks = [];
  for (const route of ["/api/health", "/api/health/ready"]) {
    const result = await new Promise((resolve) => {
      let request;
      const timer = setTimeout(
        () => request?.destroy(new Error("deadline")),
        timeoutMs,
      );
      const finish = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      request = https.get(
        new URL(route, origin),
        { ca, rejectUnauthorized: true },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16384) request.destroy(new Error("oversized"));
          });
          response.on("error", () => finish({ ok: false }));
          response.on("end", () => {
            let data;
            try {
              data = JSON.parse(body);
            } catch {
              /* fail closed */
            }
            const ready = route.endsWith("/ready");
            finish({
              ok:
                response.statusCode === 200 &&
                /max-age=[1-9][0-9]*/i.test(
                  response.headers["strict-transport-security"] ?? "",
                ) &&
                /no-store/i.test(response.headers["cache-control"] ?? "") &&
                (ready
                  ? data?.db === true && data?.worker === true
                  : data?.status === "ok"),
              status: response.statusCode,
            });
          });
        },
      );
      request.on("error", () => finish({ ok: false }));
    });
    checks.push({ route, ...result });
  }
  return {
    event: "deployment_health",
    ok: checks.every((check) => check.ok),
    checks,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [origin, flag, caFile, ...extra] = process.argv.slice(2);
    if ((flag && (flag !== "--ca" || !caFile)) || extra.length)
      throw new Error();
    const result = await probeHealth(origin, {
      ca: caFile ? readFileSync(caFile) : undefined,
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        event: "deployment_health",
        ok: false,
        reason: "Invalid configuration or probe failure",
      }),
    );
    process.exitCode = 1;
  }
}
