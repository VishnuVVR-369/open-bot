import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "./index";
import { testDatabase, testDatabaseServer } from "./testing";

const server = testDatabaseServer();
const database = testDatabase(server);

/** The server process behind a connection. */
async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

/** Ends these connections from the database's side, as a restart or an operator does. */
async function endConnections(url: string, pids: number[]) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [pids]);
  } finally {
    await admin.end();
  }
}

describe.skipIf(!server)("a pool from createPool", () => {
  beforeAll(() => database.create());
  afterAll(() => database.drop());

  it("reports an idle connection the database ended, drops it and keeps working", async () => {
    const errors: Error[] = [];
    const pool = createPool(database.url, { onIdleError: (error) => errors.push(error) });
    try {
      // Two idle connections, as a pool keeps between queries.
      const clients = await Promise.all([pool.connect(), pool.connect()]);
      const pids = await Promise.all(clients.map(backendPid));
      for (const client of clients) client.release();
      expect(pool.idleCount).toBe(2);

      await endConnections(database.url, pids);
      await expect.poll(() => errors.length).toBe(2);

      // 57P01: "terminating connection due to administrator command", which names no value.
      expect(errors.map((error) => (error as pg.DatabaseError).code)).toEqual(["57P01", "57P01"]);
      expect(pool.totalCount).toBe(0);
      const { rows } = await pool.query<{ one: number }>("select 1 as one");
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it("fails the next query of a connection taken out, instead of ending the process", async () => {
    const errors: Error[] = [];
    const pool = createPool(database.url, { onIdleError: (error) => errors.push(error) });
    try {
      // In the middle of a transaction, as when the database restarts.
      const client = await pool.connect();
      await client.query("begin");
      const pid = await backendPid(client);
      await endConnections(database.url, [pid]);

      // No listener of its own here: the one createPool adds is what keeps the process up.
      await expect
        .poll(() =>
          client.query("select 1").then(
            () => "answered",
            () => "failed",
          ),
        )
        .toBe("failed");
      client.release(true);
      // Not the pool's to report: it wasn't holding the connection.
      expect(errors).toEqual([]);
      const { rows } = await pool.query<{ one: number }>("select 1 as one");
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await pool.end();
    }
  });
});
