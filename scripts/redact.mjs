import { StringDecoder } from "node:string_decoder";

/** @param {Record<string, string | undefined>} env */
export function createRedactor(env) {
  const secrets = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (
      !value ||
      !/(?:API_KEY|SECRET|TOKEN|PEPPER|PASSWORD|DATABASE_URL)/i.test(key)
    )
      continue;
    for (const part of [value, ...value.split(/[\r\n]+/)])
      if (part) {
        secrets.add(part);
        secrets.add(encodeURIComponent(part));
        secrets.add(JSON.stringify(part).slice(1, -1));
      }
    if (/DATABASE_URL/.test(key)) {
      try {
        const url = new URL(value);
        for (const credential of [url.username, url.password])
          if (credential) {
            secrets.add(credential);
            secrets.add(decodeURIComponent(credential));
          }
      } catch {
        /* Invalid URLs are never echoed by configuration validation. */
      }
    }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  /** @param {string} line */
  return (line) => {
    for (const value of values) line = line.split(value).join("[REDACTED]");
    return line
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/"'<>]*@/gi, "$1[REDACTED]@")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-ant-[a-z0-9_-]+/gi, "[REDACTED]")
      .replace(
        /\b((?:cookie|set-cookie|authorization|x-api-key|access_code|password|secret)\s*[:=]\s*)[^\r\n]*/gi,
        "$1[REDACTED]",
      )
      .replace(/\b(tl_(?:ws|csrf)=)[^\s;"']+/gi, "$1[REDACTED]")
      .replace(
        /("(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?code|token|secret|password)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"[REDACTED]"',
      )
      .replace(
        /([?&](?:token|key|code|secret|password)=)[^\s&#"']+/gi,
        "$1[REDACTED]",
      )
      .replace(/(\/share\/)[a-z0-9_-]{16,}/gi, "$1[REDACTED]");
  };
}

/**
 * Buffer complete UTF-8 lines so secrets split across stream chunks cannot escape.
 * Oversized lines are discarded in their entirety, with bounded buffer memory.
 * @param {import('node:stream').Readable | null | undefined} stream
 * @param {(line: string) => void} emit
 * @param {(line: string) => string} redact
 * @param {number} [maxLine]
 */
export function pipeRedactedLines(stream, emit, redact, maxLine = 16_384) {
  if (!stream) return;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let dropping = false;
  /** @param {string} text */
  function accept(text) {
    for (;;) {
      const end = text.indexOf("\n");
      const part = end < 0 ? text : text.slice(0, end);
      if (!dropping) {
        if (buffer.length + part.length > maxLine) {
          buffer = "";
          dropping = true;
        } else buffer += part;
      }
      if (end < 0) return;
      emit(
        dropping
          ? "[oversized log line omitted]"
          : redact(buffer.replace(/\r$/, "")),
      );
      buffer = "";
      dropping = false;
      text = text.slice(end + 1);
    }
  }
  stream.on("data", (chunk) =>
    accept(typeof chunk === "string" ? chunk : decoder.write(chunk)),
  );
  stream.on("end", () => {
    accept(decoder.end());
    if (dropping || buffer)
      emit(dropping ? "[oversized log line omitted]" : redact(buffer));
  });
}
