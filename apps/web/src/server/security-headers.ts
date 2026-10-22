/**
 * Site-wide response headers (SECURITY §7). Built per request by the Next Proxy because HSTS
 * and `upgrade-insecure-requests` depend on the runtime `APP_ENV`: one image serves local HTTP
 * tests (`development`/`test`) and HTTPS deployments (`staging`/`production`).
 */

/** Deployed environments are always HTTPS (same rule as `secureCookiesFor`). */
export const isHttpsEnvironment = (appEnv: string | undefined): boolean =>
  appEnv === "staging" || appEnv === "production";

/** A fresh, unpredictable nonce for each page response (128 bits). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * CSP for HTML pages. Scripts: only same-origin files and Next's nonce-tagged inline scripts;
 * `'strict-dynamic'` lets those load their chunks. Styles keep `'unsafe-inline'` because React
 * renders `style` attributes (React Flow, meters), which nonces cannot cover; adding a nonce to
 * `style-src` would make browsers ignore `'unsafe-inline'`.
 */
export function pageCsp(options: {
  nonce: string;
  https: boolean;
  dev: boolean;
}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** API responses are data, never documents: nothing may load or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export function securityHeaders(options: {
  appEnv: string | undefined;
  kind: "page" | "api" | "share";
  csp: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": options.csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy":
      options.kind === "share"
        ? "no-referrer"
        : "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (options.kind === "share") {
    // Share links are capabilities: never cached, indexed, or leaked through referrers.
    headers["X-Robots-Tag"] = "noindex, nofollow";
    headers["Cache-Control"] = "private, no-store";
  }
  if (isHttpsEnvironment(options.appEnv))
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  return headers;
}
