import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * Browser E2E database: drop and recreate a dedicated database, then apply the bundled
 * release migrator (schema + pg-boss queues) exactly as a deployment would.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const target = new URL(url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
  throw new Error("E2E setup is restricted to local PostgreSQL");
const name = target.pathname.slice(1);
if (!/^tessaloom_e2e[a-z0-9_]*$/.test(name))
  throw new Error(
    "Refusing to reset a database whose name does not start with tessaloom_e2e",
  );
const admin = new URL(url);
admin.pathname = "/postgres";
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await client.query(`CREATE DATABASE "${name}"`);
await client.end();
const migrated = spawnSync(process.execPath, ["packages/db/dist/migrate.mjs"], {
  env: { ...process.env, DATABASE_URL_MIGRATOR: url },
  stdio: "inherit",
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);
