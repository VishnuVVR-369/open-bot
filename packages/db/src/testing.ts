// Integration test databases. Every suite gets its own fresh, migrated database on the Postgres
// server named by TEST_DATABASE_URL, so suites run in parallel and never see each other's rows.
// Only databases this module created (named `openbot_test_*`) are ever written to or dropped.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDb, createPool, type Db } from "./index";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
/** How long a drop waits for the database's connections to close before forcing them off. */
const CLOSE_WAIT_MS = 5_000;

/**
 * The server integration suites run against, or undefined when they should skip.
 * On CI a missing TEST_DATABASE_URL is an error, so a misconfigured job fails instead of
 * passing with every database test skipped.
 */
export function testDatabaseServer(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (url) return url;
  if (process.env.CI)
    throw new Error("TEST_DATABASE_URL is not set on CI, so the integration tests cannot run.");
  // Straight to stderr: vitest drops console output from files whose tests all skip.
  process.stderr.write(
    "Skipping integration tests: TEST_DATABASE_URL is not set. Run `pnpm test:integration` to start a disposable Postgres.\n",
  );
  return undefined;
}

export type TestDatabase = {
  /** The suite's own database. Fixed up front so code that reads it at import time can use it. */
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: Db;
  /** Creates the database and applies every migration. Call in `beforeAll`. */
  create(): Promise<void>;
  /** Closes the pool and drops the database. Call in `afterAll`. */
  drop(): Promise<void>;
};

/**
 * A database for one suite. Nothing connects until `create()`, so this is safe to call while a
 * skipped suite is being collected.
 */
export function testDatabase(server = process.env.TEST_DATABASE_URL): TestDatabase {
  const name = `openbot_test_${randomBytes(6).toString("hex")}`;
  const admin = new URL(server ?? "postgres://unused@127.0.0.1/postgres");
  const target = new URL(admin);
  target.pathname = `/${name}`;
  const url = target.toString();
  const pool = createPool(url);
  const db = createDb(pool);

  async function asAdmin(work: (client: pg.Client) => Promise<unknown>) {
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await work(client);
    } finally {
      await client.end();
    }
  }

  /**
   * Waits until no client is connected to the database, for up to `CLOSE_WAIT_MS`. `pool.end()`
   * resolves once the pool has asked its connections to close, not once they have, and a forced
   * drop would cut off one still closing: its "terminating connection" error reaches a client
   * nothing listens to any more, and vitest fails the run on it.
   * Postgres's own workers (autovacuum) are left to the drop: no client hears them stop.
   */
  async function closed(client: pg.Client) {
    const deadline = Date.now() + CLOSE_WAIT_MS;
    for (;;) {
      const { rows } = await client.query<{ open: number }>(
        `select count(*)::int as open from pg_stat_activity
         where datname = $1 and backend_type = 'client backend'`,
        [name],
      );
      const open = rows[0]?.open ?? 0;
      if (open === 0) return;
      if (Date.now() >= deadline) {
        process.stderr.write(
          `${open} connection(s) to ${name} still open after ${CLOSE_WAIT_MS} ms: a pool the suite never ended?\n`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return {
    url,
    pool,
    db,
    async create() {
      if (!server) throw new Error("TEST_DATABASE_URL is not set.");
      // The name is generated above from hex digits, never from input.
      await asAdmin((client) => client.query(`create database ${name}`));
      await migrate(db, { migrationsFolder: MIGRATIONS });
    },
    async drop() {
      await pool.end();
      if (!server) return;
      await asAdmin(async (client) => {
        await closed(client);
        // Forces off only what a suite left open past the wait.
        await client.query(`drop database if exists ${name} with (force)`);
      });
    },
  };
}
