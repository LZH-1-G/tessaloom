// RFC 8785 JSON Canonicalization Scheme for the JSON value subset used in Tessaloom keys.
// Numbers use ECMAScript serialization (as RFC 8785 requires); object keys are ordered by
// UTF-16 code units, which is JavaScript's default string sort.

export class CanonicalizationError extends Error {}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          "Non-finite numbers cannot be canonicalized",
        );
      }
      return JSON.stringify(value);
    case "string":
      if (/\p{Surrogate}/u.test(value)) {
        throw new CanonicalizationError(
          "Lone surrogates cannot be canonicalized",
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalizationError(
          "Only plain objects can be canonicalized",
        );
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError(
        `Unsupported JSON value type: ${typeof value}`,
      );
  }
}
