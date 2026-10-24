import { expect, it } from "vitest";
import { databaseFailure } from "../../packages/db/src/diagnostics";
import { verifiedDatabaseUrl } from "../../packages/config/env";

it.each([
  [new Error("pg-boss is not installed"), "queue_schema_missing"],
  [
    new Error("pg-boss database requires migrations"),
    "queue_schema_version_mismatch",
  ],
  [{ cause: { code: "42501", message: "private SQL" } }, "permission_denied"],
  [{ code: "42P01" }, "relation_missing"],
  [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls_hostname_mismatch"],
  [
    {
      code: "secret-sentinel",
      message: "secret-sentinel",
      name: "secret-sentinel",
    },
    "unknown",
  ],
  [new Error("postgres://private@host/database"), "unknown"],
  [null, "unknown"],
])(
  "classifies database failures without emitting arbitrary input",
  (error, reason) => {
    expect(databaseFailure(error)).toBe(reason);
  },
);

it.each(["require", "verify-ca", "verify-full"])(
  "pins %s to certificate and hostname verification",
  (mode) => {
    const url = new URL(
      verifiedDatabaseUrl(
        `postgres://test:sentinel@db/test?sslmode=${mode}&sslrootcert=/ca.crt`,
      ),
    );
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("sslrootcert")).toBe("/ca.crt");
  },
);

it("does not turn ambiguous options into valid configuration", () => {
  for (const query of [
    "sslmode=require&sslmode=disable",
    "sslmode=require&ssl=false",
    "sslmode=require&uselibpqcompat=true",
  ]) {
    const url = `postgres://test@db/test?${query}`;
    expect(verifiedDatabaseUrl(url)).toBe(url);
  }
});
