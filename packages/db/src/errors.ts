/** A concurrent writer changed the row first (optimistic concurrency). Maps to HTTP 409. */
export class StateConflictError extends Error {
  readonly code = "STATE_CONFLICT";
}

/** The row does not exist or is outside the caller's workspace. Maps to HTTP 404. */
export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
}

/** A domain rule rejected the write (beyond what database constraints express). */
export class DomainRuleError extends Error {
  readonly code = "VALIDATION_FAILED";
}

/**
 * Paid-work admission refused (M10-A cost safety). `code` selects the HTTP status:
 * RUN_ACCESS_REQUIRED 403, PAID_RUNS_DISABLED 503, RUN_LIMIT 429, BUSY 503.
 */
export class AdmissionError extends Error {
  constructor(
    readonly code:
      "RUN_ACCESS_REQUIRED" | "PAID_RUNS_DISABLED" | "RUN_LIMIT" | "BUSY",
    message: string,
  ) {
    super(message);
  }
}
