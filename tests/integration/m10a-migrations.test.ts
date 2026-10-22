import { describe, expect, it } from "vitest";
import { runMigrations, sql } from "../../packages/db/src";
import { createTestDatabase } from "./helpers/test-db";

describe("serialized release migrations", () => {
  it("concurrent first releases and reruns apply each migration once, including queues", async () => {
    const test = await createTestDatabase({
      migrate: async (url) => {
        await Promise.all([
          runMigrations(url),
          runMigrations(url),
          runMigrations(url),
        ]);
      },
    });
    try {
      await runMigrations(test.url);
      const result = await test.handle.db.execute<{
        n: string;
        distinct: string;
      }>(
        sql`SELECT count(*)::text AS n, count(DISTINCT hash)::text AS distinct FROM drizzle.__drizzle_migrations`,
      );
      expect(result.rows[0]).toEqual({ n: "8", distinct: "8" });
      const queues = await test.handle.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM pgboss.queue`,
      );
      expect(Number(queues.rows[0]!.n)).toBeGreaterThanOrEqual(3);
    } finally {
      await test.drop();
    }
  });
  it("waits for the advisory lock and resumes after the prior release disconnects", async () => {
    const test = await createTestDatabase();
    const holder = await test.handle.pool.connect();
    let released = false;
    try {
      await holder.query(
        "SELECT pg_advisory_lock(hashtextextended('tessaloom:migrate', 0))",
      );
      let finished = false;
      const pending = runMigrations(test.url).then(() => {
        finished = true;
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(finished).toBe(false);
      // Destroying the session models a killed migrator: PostgreSQL releases the lock.
      holder.release(true);
      released = true;
      await pending;
      expect(finished).toBe(true);
    } finally {
      if (!released) holder.release(true);
      await test.drop();
    }
  });
});
