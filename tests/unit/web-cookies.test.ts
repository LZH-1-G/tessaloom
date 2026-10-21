import { describe, expect, it } from "vitest";
import { cookie, secureCookiesFor } from "../../apps/web/src/server/http";

describe("workspace cookie security (SECURITY §4.1)", () => {
  it("always sets Secure in deployed environments", () => {
    expect(secureCookiesFor("production")).toBe(true);
    expect(secureCookiesFor("staging")).toBe(true);
  });

  it("omits Secure only for loopback HTTP servers (development, test/E2E)", () => {
    // Linux WebKit (libsoup) drops Secure cookies over http://127.0.0.1, so the E2E
    // production build would otherwise run without a workspace or CSRF cookie.
    expect(secureCookiesFor("development")).toBe(false);
    expect(secureCookiesFor("test")).toBe(false);
  });

  it("keeps HttpOnly and SameSite=Lax regardless of Secure", () => {
    for (const secure of [true, false]) {
      const header = cookie("tl_ws", "v", { httpOnly: true, secure });
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header.includes("Secure")).toBe(secure);
    }
    expect(
      cookie("tl_csrf", "v", { httpOnly: false, secure: true }),
    ).not.toContain("HttpOnly");
  });
});
