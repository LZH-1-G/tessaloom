/**
 * Preloaded into the pinned Harness CLI ONLY for the opt-in calibration test.
 * Its audited 0.1.26 HTTP client uses global fetch. Each child may issue one GET;
 * redirects and any second request are refused before network access.
 */
/** @param {typeof fetch} underlying @returns {typeof fetch} */
export function calibrationFetch(underlying) {
  let used = false;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      used ||
      url.origin !== "https://hackathon.api.qloo.com" ||
      url.pathname !== "/search" ||
      method !== "GET" ||
      url.username ||
      url.password
    )
      throw new Error("Calibration HTTP budget or endpoint denied");
    used = true;
    const deadline = AbortSignal.timeout(15_000);
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return underlying(input, {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  };
}

if (process.env.TESSALOOM_CALIBRATION_CHILD === "1")
  globalThis.fetch = calibrationFetch(globalThis.fetch);
