import { NOTIFY_CHANNELS } from "@open-bot/domain";
import { notify } from "@open-bot/db";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "./logger";
import { SignalListener } from "./signal-listener";

const server = testDatabaseServer();
const database = testDatabase(server);

function recordingLog() {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
    child: () => log,
  };
  return { log, lines };
}

/** Ends the LISTEN connection from the database's side, as a restart or an operator does. */
async function endListenConnection() {
  const admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ ended: number }>(
      `select count(pg_terminate_backend(pid))::int as ended from pg_stat_activity
       where datname = current_database() and query like 'listen %'`,
    );
    return rows[0]!.ended;
  } finally {
    await admin.end();
  }
}

describe.skipIf(!server)("the signal listener", () => {
  beforeAll(() => database.create());
  afterAll(() => database.drop());

  it("listens again after the database ends its connection, and says signals were missed", async () => {
    const payloads: string[] = [];
    let reconnects = 0;
    const { log, lines } = recordingLog();
    const listener = new SignalListener({
      pool: database.pool,
      channel: NOTIFY_CHANNELS.worker,
      onNotification: (payload) => payloads.push(payload),
      onReconnect: () => reconnects++,
      log,
      retryMs: 50,
    });
    await listener.start();
    try {
      await notify(database.pool, NOTIFY_CHANNELS.worker, "runs");
      await expect.poll(() => payloads).toEqual(["runs"]);

      expect(await endListenConnection()).toBe(1);
      await expect.poll(() => reconnects).toBe(1);
      expect(lines.map((line) => [line.level, line.message])).toEqual([
        ["warn", "signal connection failed"],
        ["info", "listening for signals again"],
      ]);
      expect(lines[0]!.fields).toMatchObject({ code: "57P01" });

      await notify(database.pool, NOTIFY_CHANNELS.worker, "cancel");
      await expect.poll(() => payloads).toEqual(["runs", "cancel"]);
    } finally {
      listener.stop();
    }
  });
});
