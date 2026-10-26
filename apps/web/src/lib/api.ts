"use client";

/** Browser-side API client: workspace bootstrap, CSRF header, typed error envelope. */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let bootstrap: Promise<void> | null = null;

/** Issues the workspace and CSRF cookies on first use (GET /api/v1/workspace). */
export function ensureWorkspace(): Promise<void> {
  bootstrap ??= fetch("/api/v1/workspace", { credentials: "same-origin" })
    .then((res) => {
      if (!res.ok)
        throw new ApiRequestError(
          res.status,
          "WORKSPACE",
          res.status === 429
            ? "Lots of new visitors right now. Wait a minute, then reload the page."
            : "Could not open your workspace.",
        );
    })
    .catch((error: unknown) => {
      bootstrap = null;
      // Browsers report network failures with raw text ("Load failed", "Failed to fetch").
      throw error instanceof ApiRequestError
        ? error
        : new ApiRequestError(
            0,
            "NETWORK",
            "Could not reach Tessaloom. Check your connection and reload.",
          );
    });
  return bootstrap;
}

function csrfToken(): string {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith("tl_csrf="));
  return match ? decodeURIComponent(match.slice("tl_csrf=".length)) : "";
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  await ensureWorkspace();
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-Tessaloom-CSRF": csrfToken() } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const error = (
      data as {
        error?: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      } | null
    )?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? "Request failed.",
      error?.details ?? {},
    );
  }
  return data as T;
}

/**
 * Public read-only endpoints (system status): no workspace bootstrap, so they still answer
 * when creating a workspace is throttled or fails.
 */
export async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "omit" });
  if (!res.ok)
    throw new ApiRequestError(res.status, "PUBLIC", "Status unavailable.");
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(
    path: string,
    body: unknown = {},
    headers?: Record<string, string>,
  ) => request<T>("POST", path, body, headers),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
