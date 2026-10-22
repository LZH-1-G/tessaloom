import { describe, expect, it } from "vitest";
import {
  API_CSP,
  createNonce,
  isHttpsEnvironment,
  pageCsp,
  securityHeaders,
} from "../../apps/web/src/server/security-headers";

/** SECURITY §7: CSP and security headers; HSTS only where the app is served over HTTPS. */
describe("security headers", () => {
  it("issues unpredictable 128-bit nonces", () => {
    const nonces = new Set(Array.from({ length: 200 }, createNonce));
    expect(nonces.size).toBe(200);
    for (const n of nonces) expect(Buffer.from(n, "base64")).toHaveLength(16);
  });

  it("builds a strict page CSP without unsafe script sources", () => {
    const csp = pageCsp({ nonce: "abc", https: true, dev: false });
    const script = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).toBe("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toMatch(/unsafe-eval|\*|https:|http:/);
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
      "upgrade-insecure-requests",
    ])
      expect(csp).toContain(directive);
    // A style nonce would make browsers ignore 'unsafe-inline' (needed for style attributes).
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src[^;]*nonce/);
  });

  it("keeps local HTTP usable: no upgrade over HTTP, eval only in development", () => {
    const local = pageCsp({ nonce: "n", https: false, dev: false });
    expect(local).not.toContain("upgrade-insecure-requests");
    expect(pageCsp({ nonce: "n", https: false, dev: true })).toContain(
      "'unsafe-eval'",
    );
  });

  it.each([
    ["production", true],
    ["staging", true],
    ["test", false],
    ["development", false],
    [undefined, false],
  ])("HSTS for APP_ENV=%s → %s", (appEnv, hsts) => {
    expect(isHttpsEnvironment(appEnv)).toBe(hsts);
    const h = securityHeaders({ appEnv, kind: "page", csp: "x" });
    expect(h["Strict-Transport-Security"] !== undefined).toBe(hsts);
    if (hsts)
      expect(h["Strict-Transport-Security"]).toBe(
        "max-age=31536000; includeSubDomains",
      );
  });

  it("sets the baseline headers on every kind, and the share-link policy on share responses", () => {
    for (const kind of ["page", "api", "share"] as const) {
      const h = securityHeaders({ appEnv: "production", kind, csp: API_CSP });
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Permissions-Policy"]).toContain("camera=()");
      expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    }
    const share = securityHeaders({ appEnv: "test", kind: "share", csp: "x" });
    expect(share["Referrer-Policy"]).toBe("no-referrer");
    expect(share["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(share["Cache-Control"]).toBe("private, no-store");
    const page = securityHeaders({ appEnv: "test", kind: "page", csp: "x" });
    expect(page["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(page["X-Robots-Tag"]).toBeUndefined();
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
