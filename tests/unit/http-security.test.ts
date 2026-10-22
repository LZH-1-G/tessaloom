import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkCsrf,
  clientIpHash,
  RateLimiter,
  readJson,
} from "../../apps/web/src/server/http";

describe("HTTP abuse boundaries", () => {
  const req = (xff: string) =>
    new Request("http://localhost", { headers: { "x-forwarded-for": xff } });
  it("ignores forged forwarding by default; uses only the configured trusted suffix", () => {
    expect(clientIpHash(req("1.2.3.4"), "p")).toBe(
      clientIpHash(req("5.6.7.8"), "p"),
    );
    expect(clientIpHash(req("1.2.3.4, 203.0.113.4"), "p", 1)).toBe(
      clientIpHash(req("5.6.7.8, 203.0.113.4"), "p", 1),
    );
    expect(clientIpHash(req("1.2.3.4, 203.0.113.4, 10.0.0.1"), "p", 2)).toBe(
      clientIpHash(req("203.0.113.4"), "p", 1),
    );
    expect(clientIpHash(req("bad"), "p", 1)).toBe(
      clientIpHash(req(""), "p", 1),
    );
    expect(clientIpHash(req("2001:db8::1"), "p", 1)).toBe(
      clientIpHash(req("2001:0db8:0:0:0:0:0:1"), "p", 1),
    );
  });
  it("rejects forged forwarded-host CSRF origins", () => {
    expect(() =>
      checkCsrf(
        new Request("http://site.test", {
          headers: {
            host: "site.test",
            origin: "https://evil.test",
            "x-forwarded-host": "evil.test",
            cookie: "tl_csrf=token",
            "x-tessaloom-csrf": "token",
          },
        }),
      ),
    ).toThrow(/Origin check failed/);
  });
  it("never evicts active limits when attackers fill the key map", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 3);
    limiter.check("victim", 1);
    limiter.check("b", 1);
    limiter.check("c", 1);
    expect(() => limiter.check("d", 1)).toThrow(/Too many/);
    expect(() => limiter.check("victim", 1)).toThrow(/Too many/);
    now = 60_001;
    expect(() => limiter.check("d", 1)).not.toThrow();
  });
  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "65537" },
    });
    await expect(readJson(request, z.unknown())).rejects.toThrow(/too large/);
  });
  it("stops an oversized chunked body without buffering the rest", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(16_384));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readJson(request, z.unknown())).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(6);
  });
  it("accepts valid multibyte JSON across chunk boundaries", async () => {
    const data = new TextEncoder().encode(JSON.stringify({ text: "中文" }));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(data.slice(0, 11));
        c.enqueue(data.slice(11));
        c.close();
      },
    });
    await expect(
      readJson(
        new Request("http://localhost", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit),
        z.object({ text: z.string() }),
      ),
    ).resolves.toEqual({ text: "中文" });
  });
});
