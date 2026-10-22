import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Repositories accept either the database or an open transaction. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(
  connectionString: string,
  options: {
    max?: number;
    applicationName?: string;
    statementTimeoutMs?: number;
  } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 5,
    application_name: options.applicationName ?? "tessaloom",
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });
  // Idle-client errors must not crash the process; queries surface their own errors.
  pool.on("error", () => {});
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** Run `work` in one transaction (DATABASE_SCHEMA.md §6). External calls never run inside. */
export function withTx<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

/** Raw SQL access to the same transaction (used for transactional pg-boss sends). */
export interface RawSql {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Run `work` in one transaction on a dedicated client and expose that client's raw SQL, so a
 * job can be enqueued atomically with the state change (DATABASE_SCHEMA §6). Rolls back on error.
 */
export async function withPgTx<T>(
  handle: Pick<DbHandle, "pool">,
  work: (tx: Tx, raw: RawSql) => Promise<T>,
): Promise<T> {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    // A drizzle instance bound to the transaction's client offers the same query API as Tx.
    const tx = drizzle(client, { schema }) as unknown as Tx;
    const raw: RawSql = {
      executeSql: async (text, values) => {
        const result = await client.query(text, values as unknown[]);
        return { rows: result.rows };
      },
    };
    const result = await work(tx, raw);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
