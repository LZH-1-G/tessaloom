import pg from "pg";
import {
  createDb,
  runMigrations,
  type DbHandle,
} from "../../../packages/db/src";

/** Creates an isolated, fully migrated database for one test file. */
export async function createTestDatabase(): Promise<{
  handle: DbHandle;
  url: string;
  drop: () => Promise<void>;
}> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl)
    throw new Error("DATABASE_URL is required for integration tests");
  const name = `tl_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const handle = createDb(url.toString(), {
    max: 10,
    applicationName: "tessaloom-test",
  });

  return {
    handle,
    url: url.toString(),
    drop: async () => {
      await handle.close();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
