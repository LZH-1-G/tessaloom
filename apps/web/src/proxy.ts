import { NextResponse, type NextRequest } from "next/server";
import {
  API_CSP,
  createNonce,
  isHttpsEnvironment,
  pageCsp,
  securityHeaders,
} from "./server/security-headers";

/**
 * Next 16 Proxy (Node runtime): security headers on every page and API response, and a fresh
 * CSP nonce per page. Next reads the nonce from the request's CSP header and applies it to its
 * own scripts during rendering (pages render dynamically; see the root layout).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const appEnv = process.env.APP_ENV;
  const api = pathname.startsWith("/api/");
  const share =
    pathname.startsWith("/share/") || pathname.startsWith("/api/v1/share/");
  const kind = share ? "share" : api ? "api" : "page";

  let response: NextResponse;
  let csp: string;
  if (api) {
    csp = API_CSP;
    response = NextResponse.next();
  } else {
    const nonce = createNonce();
    csp = pageCsp({
      nonce,
      https: isHttpsEnvironment(appEnv),
      dev: process.env.NODE_ENV === "development",
    });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  for (const [key, value] of Object.entries(
    securityHeaders({ appEnv, kind, csp }),
  ))
    response.headers.set(key, value);
  return response;
}

export const config = {
  // Static build assets are immutable files; everything else (pages and API) gets headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
