import pg from "pg";

export interface Readiness {
  db: boolean;
  worker: boolean;
}

/**
 * Readiness (API_CONTRACTS §4.8): the database answers and the worker heartbeat is younger
 * than `maxAgeSeconds`, judged by the database clock to avoid host clock skew. A fresh client
 * per check keeps a broken pool from masking an outage.
 */
export async function checkReadiness(
  connectionString: string,
  maxAgeSeconds = 30,
): Promise<Readiness> {
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
  } catch {
    await client.end().catch(() => {});
    return { db: false, worker: false };
  }
  try {
    const result = await client.query<{ fresh: boolean | null }>(
      "SELECT max(last_beat_at) > now() - make_interval(secs => $1) AS fresh FROM worker_heartbeats",
      [maxAgeSeconds],
    );
    return { db: true, worker: result.rows[0]?.fresh === true };
  } catch {
    // Not migrated yet (no heartbeat table): the database is up, the worker is not ready.
    return { db: true, worker: false };
  } finally {
    await client.end().catch(() => {});
  }
}
