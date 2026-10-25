import { expect, it } from "vitest";
import {
  databaseFailure,
  databaseDiagnostic,
} from "../../packages/db/src/diagnostics";
import { verifiedDatabaseUrl } from "../../packages/config/env";

it.each([
  [new Error("pg-boss is not installed"), "queue_schema_missing"],
  [
    new Error("required pg-boss queues are missing"),
    "queue_definitions_missing",
  ],
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

it("reports safe PostgreSQL fields through causes without SQL, parameters or secrets", () => {
  const result = databaseDiagnostic({
    cause: {
      code: "42501",
      message: "permission denied for function create_queue",
      schema: "pgboss",
      table: "queue",
      routine: "aclcheck_error",
      detail: "password=sentinel",
      where: "SQL with sentinel",
      query: "sentinel",
    },
  });
  expect(result).toEqual({
    sqlstate: "42501",
    message: "permission denied for function create_queue",
    schema: "pgboss",
    table: "queue",
    routine: "aclcheck_error",
    retryClassification: "operator_action_required",
  });
  expect(JSON.stringify(result)).not.toContain("sentinel");
});

it.each([
  "postgres://user:sentinel@private/db",
  "Bearer sentinel",
  "queue\npassword=sentinel",
])("never emits arbitrary identifiers or messages: %s", (secret) => {
  const result = databaseDiagnostic({
    code: "42501",
    message: `permission denied for table ${secret}`,
    table: secret,
    schema: secret,
    routine: secret,
    detail: secret,
  });
  expect(JSON.stringify(result)).not.toContain("sentinel");
  expect(result.sqlstate).toBe("42501");
});

it("distinguishes transient failures from operator-action failures", () => {
  expect(databaseDiagnostic({ code: "ECONNREFUSED" }).retryClassification).toBe(
    "transient",
  );
  expect(
    databaseDiagnostic(new Error("private error")).retryClassification,
  ).toBe("unknown");
});

it.each(["23514", "08006", "XX000"])(
  "preserves valid unclassified SQLSTATE %s without raw details",
  (code) => {
    expect(
      databaseDiagnostic({
        code,
        message: "password=sentinel",
        detail: "sentinel",
      }),
    ).toEqual({ sqlstate: code, retryClassification: "unknown" });
  },
);

it("distinguishes OS codes from custom PostgreSQL SQLSTATE", () => {
  expect(databaseDiagnostic({ code: "EPERM" })).not.toHaveProperty("sqlstate");
  expect(databaseDiagnostic({ code: "EPIPE" })).not.toHaveProperty("sqlstate");
  expect(
    databaseDiagnostic({
      code: "ABCDE",
      severity: "ERROR",
      message: "secret-sentinel",
    }),
  ).toEqual({ sqlstate: "ABCDE", retryClassification: "unknown" });
});
