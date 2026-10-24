import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Return only diagnostic codes, never subprocess arguments, output or credentials.
 * @param {unknown} error
 */
export function failureSummary(error) {
  const e = /** @type {{name?: unknown, code?: unknown, status?: unknown}} */ (
    error ?? {}
  );
  return {
    name:
      typeof e.name === "string" && /^[A-Za-z]+Error$/.test(e.name)
        ? e.name
        : "Error",
    ...(typeof e.code === "string" && /^E[A-Z_]+$/.test(e.code)
      ? { code: e.code }
      : {}),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
  };
}

/**
 * A pending promise (including AbortSignal.timeout) need not keep Node alive.
 * Own a referenced deadline for the WHOLE wait, not just the gaps between probes.
 * The race also bounds a probe that never settles or ignores cancellation.
 * Synchronous probes must use remainingMs() as their subprocess timeout: no JS
 * timer can interrupt a blocking execFileSync. Never accept success after expiry.
 * @param {(context: {signal: AbortSignal, remainingMs: () => number}) => boolean | Promise<boolean>} check
 * @param {{label: string, timeoutMs?: number, intervalMs?: number}} options
 */
export async function until(
  check,
  { label, timeoutMs = 60_000, intervalMs = 200 },
) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new RangeError("Invalid smoke polling timeout/interval");
  }
  const started = performance.now();
  const remainingMs = () =>
    Math.max(0, Math.ceil(timeoutMs - (performance.now() - started)));
  const controller = new AbortController();
  let attempts = 0;
  let lastOutcome = "pending";
  /** @type {ReturnType<typeof failureSummary> | undefined} */
  let lastFailure;
  const timedOut = () =>
    Object.assign(new Error(`Smoke check timed out: ${label}`), {
      name: "SmokeTimeoutError",
      label,
      timeoutMs,
      attempts,
      elapsedMs: Math.round(performance.now() - started),
      lastOutcome,
      lastFailure,
    });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timedOut());
      controller.abort();
    }, timeoutMs); // Deliberately referenced; clear in finally on every exit.
  });
  try {
    while (remainingMs() > 0) {
      attempts++;
      lastOutcome = "pending";
      try {
        const ready = await Promise.race([
          Promise.resolve().then(() =>
            check({ signal: controller.signal, remainingMs }),
          ),
          expired,
        ]);
        if (remainingMs() === 0) throw timedOut();
        if (ready) return;
        lastOutcome = "false";
      } catch (error) {
        if (controller.signal.aborted || remainingMs() === 0) throw timedOut();
        lastOutcome = "error";
        lastFailure = failureSummary(error);
      }
      await Promise.race([
        delay(Math.min(intervalMs, remainingMs()), undefined, {
          signal: controller.signal,
        }),
        expired,
      ]);
    }
    throw timedOut();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** HTTP status probe with bounded I/O and no retained response/socket body.
 * @param {string} url
 * @param {number} expected
 * @param {AbortSignal} signal
 */
export async function hasStatus(url, expected, signal) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
  });
  try {
    if (response.status !== expected) {
      throw Object.assign(new Error("Unexpected HTTP status"), {
        status: response.status,
      });
    }
    return true;
  } finally {
    await response.body?.cancel();
  }
}
