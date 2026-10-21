import pg from "pg";

export async function checkDatabase(
  connectionString: string,
): Promise<boolean> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  // Connection failures must not become unhandled events or leak connection details.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
