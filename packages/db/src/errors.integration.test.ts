import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorFields, errorMessage } from "./errors";
import { tasks } from "./schema";
import { testDatabase, testDatabaseServer } from "./testing";

/** The parts of an error a log can show. Its message is not an own property, so it is read here. */
function shown(error: unknown) {
  const { message, code, constraint, detail, where } = error as pg.DatabaseError;
  return { message, code, constraint, detail, where };
}

const server = testDatabaseServer();
const database = testDatabase(server);
const { db, pool } = database;

/** What a log that prints the error whole (Next.js, Better Auth) would show. */
async function logged(work: Promise<unknown>): Promise<{ error: Error; printed: string }> {
  const error = await work.then(
    () => {
      throw new Error("the query was meant to fail");
    },
    (failed: unknown) => failed as Error,
  );
  return { error, printed: `${inspect(error, { depth: null })}\n${String(error.stack)}` };
}

describe.skipIf(!server)("a failed query", () => {
  beforeAll(() => database.create());
  afterAll(() => database.drop());

  it("never shows a refused text value: a NUL byte, as Postgres refuses it (22021)", async () => {
    const { error, printed } = await logged(
      db.select().from(tasks).where(eq(tasks.title, "a private\u0000phrase")),
    );
    expect(error.message).toMatch(
      /^Failed query: select .* from "tasks" where "tasks"\."title" = \$1$/,
    );
    expect(error.cause).toBeInstanceOf(pg.DatabaseError);
    expect(shown(error.cause)).toEqual({
      message: "The database refused the query (SQLSTATE 22021).",
      code: "22021",
      constraint: undefined,
      detail: undefined,
      where: undefined,
    });
    expect(printed).not.toContain("private");
    expect(errorMessage(error)).toBe("The database refused the query (SQLSTATE 22021).");
  });

  it("never shows a value Postgres quotes in its message (22P02)", async () => {
    const { error, printed } = await logged(
      db.insert(tasks).values({ id: "private-id", title: "Plan", createdBy: "user" }),
    );
    expect(error.cause).toMatchObject({ code: "22P02" });
    expect(printed).not.toContain("private");
  });

  it("keeps a constraint's name but never the key in the detail (23505)", async () => {
    const id = randomUUID();
    await db.insert(tasks).values({ id, title: "Plan", createdBy: "user" });
    const { error, printed } = await logged(
      db.insert(tasks).values({ id, title: "Plan again", createdBy: "user" }),
    );
    expect(shown(error.cause)).toEqual({
      message: 'duplicate key value violates unique constraint "tasks_pkey"',
      code: "23505",
      constraint: "tasks_pkey",
      detail: undefined,
      where: undefined,
    });
    expect(printed).not.toContain(id);
    expect(errorFields(error)).toMatchObject({ code: "23505", constraint: "tasks_pkey" });
  });

  it("is as safe in a transaction, in raw SQL and on the pool's own query", async () => {
    const failures = [
      () => db.transaction((tx) => tx.execute(sql`select ${"a private value"}::int`)),
      () => db.execute(sql`select ${"a private value"}::int`),
      () => pool.query("select $1::int", ["a private value"]),
      () =>
        new Promise((_resolve, reject) =>
          pool.query("select $1::int", ["a private value"], (error) => reject(error)),
        ),
    ];
    for (const failure of failures) {
      const { error, printed } = await logged(failure());
      expect(errorMessage(error)).toBe("The database refused the query (SQLSTATE 22P02).");
      expect(printed).not.toContain("private");
    }
  });

  it("still runs every other query", async () => {
    const client = await pool.connect();
    try {
      expect((await client.query("select $1::int as n", [7])).rows).toEqual([{ n: 7 }]);
    } finally {
      client.release();
    }
    expect((await pool.query({ text: "select 1 as n" })).rows).toEqual([{ n: 1 }]);
  });
});
