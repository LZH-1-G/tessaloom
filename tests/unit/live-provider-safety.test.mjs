import { describe, expect, it, vi } from "vitest";
import { calibrationFetch } from "../../scripts/qloo-calibration-guard.mjs";
import { qlooChildEnv } from "../../packages/qloo-adapter/src/transports/env";

const url = "https://hackathon.api.qloo.com/search?query=Lisbon&take=2";
describe("calibration HTTP boundary (fake fetch, no live services)", () => {
  it("permits one GET per child, rejects concurrent extra requests, and prohibits redirects", async () => {
    const network = vi.fn().mockResolvedValue(new Response("[]"));
    const fetcher = calibrationFetch(network);
    const outcomes = await Promise.allSettled([fetcher(url), fetcher(url)]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected"]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    "https://api.qloo.com/search",
    "https://hackathon.api.qloo.com/v2/insights",
    "http://hackathon.api.qloo.com/search",
    "https://user:password@hackathon.api.qloo.com/search",
  ])("refuses unapproved endpoint %s before network", async (endpoint) => {
    const network = vi.fn();
    await expect(calibrationFetch(network)(endpoint)).rejects.toThrow("denied");
    expect(network).not.toHaveBeenCalled();
  });
  it("does not retry failed HTTP responses or network failures", async () => {
    const network = vi.fn().mockRejectedValue(new Error("offline"));
    const fetcher = calibrationFetch(network);
    await expect(fetcher(url)).rejects.toThrow("offline");
    await expect(fetcher(url)).rejects.toThrow("denied");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("refuses POST and strips model and database secrets from Qloo subprocesses", async () => {
    const network = vi.fn();
    await expect(
      calibrationFetch(network)(url, { method: "POST" }),
    ).rejects.toThrow("denied");
    expect(network).not.toHaveBeenCalled();
    expect(
      qlooChildEnv({
        PATH: "/trusted",
        HOME: "/private",
        QLOO_API_KEY: "qloo",
        QLOO_HOME: "/qloo",
        GEMINI_API_KEY: "model",
        DEEPSEEK_API_KEY: "deepseek-model",
        ANTHROPIC_API_KEY: "other-model",
        DATABASE_URL: "private-db",
        NODE_OPTIONS: "untrusted",
        SOME_API_KEY: "unknown",
      }),
    ).toEqual({
      PATH: "/trusted",
      HOME: "/private",
      QLOO_API_KEY: "qloo",
      QLOO_HOME: "/qloo",
    });
  });
});

describe("Phase 2 exact-request boundary (synthetic IDs, no network)", () => {
  const approved =
    "https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Abook&take=1&signal.interests.entities=11111111-1111-4111-8111-111111111111";
  it("permits only the exact Insights request and one dispatch, including on HTTP failure", async () => {
    const network = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 429 }));
    const guarded = calibrationFetch(network, approved);
    expect((await guarded(approved)).status).toBe(429);
    await expect(guarded(approved)).rejects.toThrow("denied");
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1].redirect).toBe("error");
  });
  it.each([
    approved.replace("take=1", "take=20"),
    approved + "&page=2",
    approved + "#ignored",
    url,
  ])("blocks drift or fan-out before any HTTP dispatch: %s", async (actual) => {
    const network = vi.fn();
    await expect(calibrationFetch(network, approved)(actual)).rejects.toThrow(
      "denied",
    );
    expect(network).not.toHaveBeenCalled();
  });
});
