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
  options: { max?: number; applicationName?: string } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 5,
    application_name: options.applicationName ?? "tessaloom",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  // Idle-client errors must not crash the process; queries surface their own errors.
  pool.on("error", () => {});
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** Run `work` in one transaction (DATABASE_SCHEMA.md §6). External calls never run inside. */
export function withTx<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(work);
}
