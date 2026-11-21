import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "./index";
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

/**
 * Forwards TCP to the database, and cuts the connection the moment the client sends a query whose
 * text is `cutOn`: the database going away halfway through a transaction's statements.
 */
async function cuttingRelay(url: string) {
  const target = new URL(url);
  const sockets = new Set<net.Socket>();
  const relay = {
    cutOn: null as string | null,
    url: "",
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.on("data", (chunk: Buffer) => {
      // A simple query is the byte "Q", a length, then its text ending in a zero byte.
      if (relay.cutOn && chunk[0] === 0x51 && chunk.subarray(5, -1).toString() === relay.cutOn) {
        client.destroy();
        upstream.destroy();
      } else upstream.write(chunk);
    });
    upstream.pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const relayed = new URL(url);
  relayed.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.url = relayed.toString();
  return relay;
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

  it("gets back a connection lost while a transaction begins, so it can still end", async () => {
    const relay = await cuttingRelay(database.url);
    const pool = createPool(relay.url, { onIdleError: () => {} });
    const db = createDb(pool);
    try {
      relay.cutOn = "begin";
      await expect(db.transaction(async () => {})).rejects.toThrow();
      // Never given back, the connection would stay taken out forever: the pool keeps counting
      // it, and `pool.end()` waits for it, as a worker shutting down would.
      await expect.poll(() => pool.totalCount).toBe(0);
      relay.cutOn = null;
      const answered = await db.transaction((tx) => tx.execute(sql`select 1 as one`));
      expect(answered.rows).toEqual([{ one: 1 }]);
    } finally {
      // A connection still taken out means the test failed already, and ending would hang.
      if (pool.totalCount === pool.idleCount) await pool.end();
      relay.close();
    }
  });
});
