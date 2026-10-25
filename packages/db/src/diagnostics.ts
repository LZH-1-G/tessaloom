/** Fixed vocabulary only: raw driver messages and connection details are private. */
export function databaseFailure(error: unknown): string {
  const codes: Record<string, string> = {
    "42501": "permission_denied",
    "42P01": "relation_missing",
    "42703": "column_missing",
    "42883": "function_missing",
    "3F000": "schema_missing",
    "40001": "serialization_failure",
    "40P01": "deadlock",
    "25P02": "transaction_aborted",
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
    if (e.message === "required pg-boss queues are missing")
      return "queue_definitions_missing";
    current = e.cause;
  }
  return "unknown";
}

const safeObjects = new Set([
  "public",
  "pgboss",
  "version",
  "queue",
  "job",
  "job_common",
  "schedule",
  "subscription",
  "bam",
  "warning",
  "job_dependency",
  "instance",
  "queue_stats",
  "worker_heartbeats",
  "prompt_templates",
  "create_queue",
  "delete_queue",
  "job_now",
  "job_table_format",
  "job_table_run",
  "job_table_run_async",
  "pg_advisory_xact_lock",
  "sha224",
]);
const safeRoutines = new Set([
  "aclcheck_error",
  "aclcheck_error_col",
  "object_ownercheck",
]);

/** Allowlisted templates rather than regex-redacting arbitrary SQL/credentials from a message. */
export function databaseDiagnostic(error: unknown) {
  const reason = databaseFailure(error);
  const result: Record<string, string> = {
    retryClassification:
      [
        "permission_denied",
        "authentication_failed",
        "authorization_failed",
        "queue_schema_missing",
        "queue_schema_version_mismatch",
        "queue_definitions_missing",
        "relation_missing",
        "column_missing",
        "database_missing",
        "function_missing",
        "schema_missing",
      ].includes(reason) || reason.startsWith("tls_")
        ? "operator_action_required"
        : reason === "unknown"
          ? "unknown"
          : "transient",
  };
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const e = current as Record<string, unknown>;
    // Node codes such as EPERM/EPIPE also have five letters. Standard PostgreSQL
    // classes or a server severity distinguish SQLSTATE, including custom codes.
    if (
      typeof e.code === "string" &&
      /^[0-9A-Z]{5}$/.test(e.code) &&
      (/^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)/.test(e.code) ||
        ["ERROR", "FATAL", "PANIC"].includes(String(e.severity)))
    )
      result.sqlstate = e.code;
    for (const key of ["schema", "table"] as const)
      if (typeof e[key] === "string" && safeObjects.has(e[key]))
        result[key] = e[key];
    if (typeof e.routine === "string" && safeRoutines.has(e.routine))
      result.routine = e.routine;
    if (typeof e.message === "string") {
      const match =
        /^(permission denied for (?:table|schema|function|sequence|database)|must be owner of (?:table|schema|function)) (.+)$/.exec(
          e.message,
        );
      if (match) {
        const name = match[2]!;
        result.message = `${match[1]} ${safeObjects.has(name) ? name : "[redacted]"}`;
      }
    }
    current = e.cause;
  }
  return result;
}
