/** Qloo subprocesses need Qloo credentials only; never forward model keys or DB credentials. */
export function qlooChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "NODE_ENV",
    "QLOO_HOME",
    "QLOO_API_KEY",
    "QLOO_BASE_URL",
    "QLOO_TRUSTED_BASE_URL",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        allowed.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}
