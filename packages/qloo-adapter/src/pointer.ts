// RFC 6901 JSON Pointer lookup, used to extract and verify evidence facts at ingest
// (raw responses are discarded afterwards while raw retention is off).

export function resolvePointer(
  document: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: document };
  if (!pointer.startsWith("/")) return { found: false };
  let current: unknown = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length)
        return { found: false };
      current = current[Number(token)];
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, token)
    ) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** True when `document` holds exactly `expected` (deep, JSON semantics) at `pointer`. */
export function verifyPointer(
  document: unknown,
  pointer: string,
  expected: unknown,
): boolean {
  const { found, value } = resolvePointer(document, pointer);
  return found && JSON.stringify(value) === JSON.stringify(expected);
}
