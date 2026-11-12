import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { databaseError, errorFields, errorMessage, withoutValues } from "./errors";

const SQL = 'insert into "user" ("name", "email") values ($1, $2)';
const PARAMS = ["Private Name", "private@example.test"];

/** The parts of an error a log can show. Its message is not an own property, so it is read here. */
function shown(error: unknown) {
  const { message, code, table, constraint, detail, where } = error as pg.DatabaseError;
  return { message, code, table, constraint, detail, where };
}

/** A Postgres error as node-postgres gives it, with the fields that can hold values. */
function postgresError(message: string, fields: Partial<pg.DatabaseError>): pg.DatabaseError {
  return Object.assign(new pg.DatabaseError(message, 0, "error"), fields);
}

const taken = () =>
  postgresError('duplicate key value violates unique constraint "user_email_unique"', {
    code: "23505",
    table: "user",
    constraint: "user_email_unique",
    detail: "Key (email)=(private@example.test) already exists.",
  });
const refused = () =>
  postgresError('invalid input syntax for type integer: "Private Name"', {
    code: "22P02",
    where: "unnamed portal parameter $1 = 'Private Name'",
  });

describe("a failed query's error", () => {
  it("never holds its parameters, however it is logged", () => {
    const failed = new DrizzleQueryError(SQL, PARAMS, new Error("boom"));
    expect(failed.message).toBe(`Failed query: ${SQL}`);
    expect(failed.name).toBe("DrizzleQueryError");
    expect(failed.query).toBe(SQL);
    expect(`${inspect(failed, { depth: null })} ${failed.stack}`).not.toMatch(/private/i);
  });
});

describe("withoutValues", () => {
  it("keeps a message that only names things, and drops the detail", () => {
    const safe = withoutValues(taken());
    expect(safe).toBeInstanceOf(pg.DatabaseError);
    expect(shown(safe)).toEqual({
      message: 'duplicate key value violates unique constraint "user_email_unique"',
      code: "23505",
      table: "user",
      constraint: "user_email_unique",
      detail: undefined,
      where: undefined,
    });
    expect(inspect(safe)).not.toMatch(/private/i);
  });

  it("replaces a message that can quote the value it refused, and drops the where", () => {
    const original = refused();
    const safe = withoutValues(original);
    expect(shown(safe)).toEqual({
      message: "The database refused the query (SQLSTATE 22P02).",
      code: "22P02",
      table: undefined,
      constraint: undefined,
      detail: undefined,
      where: undefined,
    });
    expect(`${inspect(safe)} ${(safe as Error).stack}`).not.toMatch(/private/i);
    expect(shown(withoutValues(safe))).toEqual(shown(safe));
  });

  it("returns anything else as it is", () => {
    const other = new Error("boom");
    expect(withoutValues(other)).toBe(other);
    expect(withoutValues("text")).toBe("text");
  });
});

describe("errorMessage and errorFields", () => {
  it("give what the database said, without values, and the SQL", () => {
    for (const cause of [taken(), refused()]) {
      const failed = new DrizzleQueryError(SQL, PARAMS, cause);
      expect(errorMessage(failed)).toBe(withoutValues(cause).message);
      expect(errorFields(failed)).toEqual({
        error: errorMessage(failed),
        query: SQL,
        code: cause.code,
        table: cause.table,
        column: undefined,
        constraint: cause.constraint,
      });
      expect(inspect(errorFields(failed))).not.toMatch(/private/i);
    }
  });

  it("know a failed query from a second copy of Drizzle by its name", () => {
    const copy = Object.assign(new Error(`Failed query: ${SQL}`), {
      name: "DrizzleQueryError",
      query: SQL,
      cause: refused(),
    });
    expect(errorMessage(copy)).toBe("The database refused the query (SQLSTATE 22P02).");
    expect(errorFields(copy)).toMatchObject({ query: SQL, code: "22P02" });
    expect(errorFields(copy).stack).toBeUndefined();
  });

  it("say a failed query without a cause failed, and keep any other error's stack", () => {
    expect(databaseError(new DrizzleQueryError(SQL, PARAMS))).toEqual(
      new Error("A database query failed."),
    );
    const other = new Error("boom");
    expect(errorFields(other)).toEqual({ error: "boom", stack: other.stack });
  });
});
