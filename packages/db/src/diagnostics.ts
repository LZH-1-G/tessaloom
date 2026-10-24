/** Fixed vocabulary only: driver messages, SQL, identifiers and connection details are private. */
export function databaseFailure(error: unknown): string {
  const codes: Record<string, string> = {
    "42501": "permission_denied",
    "42P01": "relation_missing",
    "42703": "column_missing",
    "28P01": "authentication_failed",
    "28000": "authorization_failed",
    "3D000": "database_missing",
    "53300": "connections_exhausted",
    "57P01": "database_stopping",
    "57014": "query_timeout",
    ECONNREFUSED: "connection_refused",
    ECONNRESET: "connection_reset",
    ETIMEDOUT: "connection_timeout",
    ENOTFOUND: "dns_failed",
    EAI_AGAIN: "dns_failed",
    CERT_HAS_EXPIRED: "tls_certificate_expired",
    DEPTH_ZERO_SELF_SIGNED_CERT: "tls_untrusted",
    SELF_SIGNED_CERT_IN_CHAIN: "tls_untrusted",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_untrusted",
    ERR_TLS_CERT_ALTNAME_INVALID: "tls_hostname_mismatch",
  };
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && Object.hasOwn(codes, e.code))
      return codes[e.code]!;
    if (e.message === "pg-boss is not installed") return "queue_schema_missing";
    if (e.message === "pg-boss database requires migrations")
      return "queue_schema_version_mismatch";
    current = e.cause;
  }
  return "unknown";
}
