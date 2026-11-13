import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "./testing";

const url = testDatabaseServer();

describe.skipIf(!url)("test databases", () => {
  const database = testDatabase(url);

  beforeAll(async () => {
    await database.create();
  });

  // `pool.end()` resolves once the pool has asked its connections to close, not once they have.
  // A drop that forced them off right then reached connections still closing, and their
  // "terminating connection" error, which nothing listened for any more, failed the run on CI.
  // The test drops a database, which other suites do in `afterAll` with its 10s limit: on a CI
  // runner where every package creates and drops databases at once, it took over 5s.
  it(
    "wait for a connection that is still closing before they drop",
    { timeout: 30_000 },
    async () => {
      const closing = new pg.Client({ connectionString: database.url });
      await closing.connect();
      const errors: Error[] = [];
      closing.on("error", (error) => errors.push(error));

      const dropped = database.drop();
      // Slow to close, as a busy machine makes a pool's connections.
      setTimeout(() => void closing.end(), 300);
      await dropped;

      expect(errors.map((error) => error.message)).toEqual([]);
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
          new URL(database.url).pathname.slice(1),
        ]);
        expect(rows).toEqual([]);
      } finally {
        await admin.end();
      }
    },
  );
});
