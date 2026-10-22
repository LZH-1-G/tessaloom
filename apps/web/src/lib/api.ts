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
          "Could not open your workspace.",
        );
    })
    .catch((error: unknown) => {
      bootstrap = null;
      throw error;
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

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(
    path: string,
    body: unknown = {},
    headers?: Record<string, string>,
  ) => request<T>("POST", path, body, headers),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
};
