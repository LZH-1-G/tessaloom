import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { z } from "zod";
import { ZodError } from "zod";
import { uuidv7 } from "@tessaloom/core";
import {
  DomainRuleError,
  NotFoundError,
  StateConflictError,
} from "@tessaloom/db";

/** API_CONTRACTS §3.3 error envelope. */
export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "WORKSPACE_REQUIRED"
  | "FORBIDDEN"
  | "CSRF_FAILED"
  | "NOT_FOUND"
  | "STATE_CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "RATE_LIMITED"
  | "QUOTA_GUARD_ACTIVE"
  | "WORKER_OFFLINE";

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  WORKSPACE_REQUIRED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  RATE_LIMITED: 429,
  QUOTA_GUARD_ACTIVE: 429,
  WORKER_OFFLINE: 503,
};

export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> | Headers = {},
): Response {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!h.has(k)) h.set(k, v);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** Map errors to the envelope. Internal details never reach the client (SECURITY §7). */
export function errorResponse(error: unknown): Response {
  const requestId = uuidv7();
  let e: HttpError;
  if (error instanceof HttpError) e = error;
  else if (error instanceof ZodError)
    e = new HttpError("VALIDATION_FAILED", "The request is invalid.", {
      issues: error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  else if (error instanceof NotFoundError)
    e = new HttpError("NOT_FOUND", "Not found.");
  else if (error instanceof StateConflictError)
    e = new HttpError("STATE_CONFLICT", error.message);
  else if (error instanceof DomainRuleError)
    e = new HttpError("VALIDATION_FAILED", error.message);
  else {
    console.error(
      JSON.stringify({
        event: "api_error",
        requestId,
        name: (error as Error)?.name ?? "unknown",
      }),
    );
    return json(
      {
        error: {
          code: "INTERNAL",
          message: "Something went wrong.",
          retryable: true,
          requestId,
          details: {},
        },
      },
      500,
    );
  }
  return json(
    {
      error: {
        code: e.code,
        message: e.message,
        retryable: e.code === "RATE_LIMITED" || e.code === "WORKER_OFFLINE",
        requestId,
        details: e.details,
      },
    },
    STATUS[e.code],
    e.headers,
  );
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new HttpError("VALIDATION_FAILED", "The request body is too large.");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(
      "VALIDATION_FAILED",
      "The request body is not valid JSON.",
    );
  }
  return schema.parse(body);
}

// --- Cookies and CSRF (SECURITY §4.1, §7) ---

export const WORKSPACE_COOKIE = "tl_ws";
export const CSRF_COOKIE = "tl_csrf";
export const CSRF_HEADER = "x-tessaloom-csrf";

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Whether cookies carry `Secure` (SECURITY §4.1). Deployed environments are always served over
 * HTTPS and always set it. Development and test servers run over plain loopback HTTP, where
 * Linux WebKit (libsoup) drops `Secure` cookies (no loopback exception, unlike Chromium), which
 * would leave the browser without a workspace or CSRF cookie. The deciding input is where the
 * app is deployed (APP_ENV), not NODE_ENV: E2E runs the production build over HTTP.
 */
export const secureCookiesFor = (appEnv: string): boolean =>
  appEnv !== "development" && appEnv !== "test";

export function cookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    "Max-Age=31536000",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export const randomToken = () => randomBytes(32).toString("base64url");

/** The server stores only HMAC-SHA-256(secret, SESSION_SECRET). */
export const hashWorkspaceSecret = (secret: string, sessionSecret: string) =>
  createHmac("sha256", sessionSecret).update(secret).digest("hex");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Double-submit token + Origin/Host check on every mutation. */
export function checkCsrf(req: Request): void {
  const token = parseCookies(req)[CSRF_COOKIE];
  const header = req.headers.get(CSRF_HEADER);
  if (!token || !header || !safeEqual(token, header))
    throw new HttpError("CSRF_FAILED", "Missing or invalid CSRF token.");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host)
    throw new HttpError("CSRF_FAILED", "Origin check failed.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError("CSRF_FAILED", "Origin check failed.");
  }
  if (originHost !== host)
    throw new HttpError("CSRF_FAILED", "Origin check failed.");
}

// --- Rate limiting (per process; the app runs as a single service, ADR-017) ---

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Sliding window. Throws 429 with Retry-After when the limit is exceeded. */
  check(key: string, limit: number, windowMs = 60_000): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (t - recent[0]!)) / 1000),
      );
      this.hits.set(key, recent);
      throw new HttpError(
        "RATE_LIMITED",
        "Too many requests. Please slow down.",
        {},
        { "Retry-After": String(retryAfter) },
      );
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear(); // bounded memory under abuse
  }
}

/** IP is only used hashed, as a rate-limit key. */
export function clientIpHash(req: Request, pepper: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return createHash("sha256")
    .update(`${pepper}:${ip}`)
    .digest("hex")
    .slice(0, 32);
}
