import { EventEmitter } from "node:events";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger";
import { SignalListener } from "./signal-listener";

/** A pool client stand-in: it records releases, and `fail` acts as a dropped connection. */
class StandInClient extends EventEmitter {
  released: (Error | boolean | undefined)[] = [];
  queries: string[] = [];
  query = vi.fn(async (sql: string) => {
    this.queries.push(sql);
    return { rows: [] };
  });
  release(error?: Error | boolean) {
    if (this.released.length)
      throw new Error("Release called on client which has already been released.");
    this.released.push(error);
  }
  fail(error: Error) {
    this.emit("error", error);
  }
}

/** A pool stand-in whose `connect` fails `refusals` times, then hands out new clients. */
function standInPool(refusals = 0) {
  const clients: StandInClient[] = [];
  let refused = 0;
  const pool = {
    connect: vi.fn(async () => {
      if (refused < refusals) {
        refused++;
        throw new Error("connect ECONNREFUSED");
      }
      const client = new StandInClient();
      clients.push(client);
      return client;
    }),
  };
  return { pool: pool as unknown as pg.Pool, clients, connects: pool.connect };
}

const quietLog: Logger = { info() {}, warn() {}, error() {}, child: () => quietLog };

function listenerFor(pool: pg.Pool, onReconnect = vi.fn()) {
  const payloads: string[] = [];
  const listener = new SignalListener({
    pool,
    channel: "openbot_worker",
    onNotification: (payload) => payloads.push(payload),
    onReconnect,
    log: quietLog,
    retryMs: 1_000,
  });
  return { listener, payloads, onReconnect };
}

describe("SignalListener", () => {
  it("drops a failed connection from the pool once and listens on a new one", async () => {
    vi.useFakeTimers();
    try {
      const { pool, clients } = standInPool();
      const { listener, payloads, onReconnect } = listenerFor(pool);
      await listener.start();
      expect(clients[0]!.queries).toEqual(["listen openbot_worker"]);

      const lost = new Error("terminating connection due to administrator command");
      clients[0]!.fail(lost);
      // A client can report more than one error; the second must not release it again.
      clients[0]!.fail(new Error("Connection terminated unexpectedly"));
      expect(clients[0]!.released).toEqual([lost]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(clients).toHaveLength(2);
      expect(clients[1]!.queries).toEqual(["listen openbot_worker"]);
      expect(onReconnect).toHaveBeenCalledTimes(1);

      clients[1]!.emit("notification", { channel: "openbot_worker", payload: "runs" });
      expect(payloads).toEqual(["runs"]);
      listener.stop();
      expect(clients[1]!.released).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits longer each time a new connection can't be made", async () => {
    vi.useFakeTimers();
    try {
      const { pool, clients, connects } = standInPool();
      const { listener, onReconnect } = listenerFor(pool);
      await listener.start();
      connects.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      connects.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      clients[0]!.fail(new Error("Connection terminated unexpectedly"));

      await vi.advanceTimersByTimeAsync(1_000); // first try: refused
      await vi.advanceTimersByTimeAsync(2_000); // second, after twice the wait: refused
      expect(connects).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(connects).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1); // third, after four times the wait
      expect(connects).toHaveBeenCalledTimes(4);
      expect(clients).toHaveLength(2);
      expect(onReconnect).toHaveBeenCalledTimes(1);
      listener.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops trying once stopped", async () => {
    vi.useFakeTimers();
    try {
      const { pool, clients, connects } = standInPool();
      const { listener } = listenerFor(pool);
      await listener.start();
      clients[0]!.fail(new Error("Connection terminated unexpectedly"));
      listener.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connects).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails to start when the first connection can't be made", async () => {
    const { pool } = standInPool(1);
    const { listener } = listenerFor(pool);
    await expect(listener.start()).rejects.toThrow("ECONNREFUSED");
  });
});
