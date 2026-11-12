import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authLog } from "./auth-log";

/** A Postgres error as node-postgres gives it, with the fields that can hold values. */
function postgresError(message: string, fields: Partial<pg.DatabaseError>): pg.DatabaseError {
  return Object.assign(new pg.DatabaseError(message, 0, "error"), fields);
}

const SQL = 'insert into "user" ("name", "email") values ($1, $2)';
const PARAMS = ["Private Name", "private@example.test"];

describe("Better Auth's log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records a failed query's code and SQL, never its parameters, detail or refused value", () => {
    // Made by hand, so they still hold the values our pools take out: the log drops them too.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const taken = postgresError(
      'duplicate key value violates unique constraint "user_email_unique"',
      {
        code: "23505",
        table: "user",
        constraint: "user_email_unique",
        detail: "Key (email)=(private@example.test) already exists.",
      },
    );
    const refused = postgresError('invalid input syntax for type integer: "Private Name"', {
      code: "22P02",
      where: "unnamed portal parameter $1 = 'Private Name'",
    });
    authLog("error", "Failed to create user", new DrizzleQueryError(SQL, PARAMS, taken));
    authLog("error", "Failed to create user", new DrizzleQueryError(SQL, PARAMS, refused));
    expect(logged.mock.calls.map((call) => call.slice(1))).toEqual([
      [
        {
          error: 'duplicate key value violates unique constraint "user_email_unique"',
          query: SQL,
          code: "23505",
          table: "user",
          column: undefined,
          constraint: "user_email_unique",
        },
      ],
      [
        {
          error: "The database refused the query (SQLSTATE 22P02).",
          query: SQL,
          code: "22P02",
          table: undefined,
          column: undefined,
          constraint: undefined,
        },
      ],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private/i);
  });

  it("logs a failed query's message given as the line's text, which never has its parameters", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = new DrizzleQueryError(SQL, PARAMS, new Error("boom"));
    authLog("error", failed.message);
    const [line] = logged.mock.calls[0]!;
    expect(line).toMatch(
      / ERROR \[Better Auth\]: Failed query: insert into "user" \("name", "email"\) values \(\$1, \$2\)$/,
    );
    expect(String(line)).not.toMatch(/private/i);
  });

  it("logs a failed query given as the line's text, as Better Auth's session list does", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = new DrizzleQueryError(SQL, PARAMS, postgresError("canceled", { code: "XX000" }));
    authLog("error", failed);
    const [line, fields] = logged.mock.calls[0]!;
    expect(line).toMatch(
      / ERROR \[Better Auth\]: The database refused the query \(SQLSTATE XX000\)\.$/,
    );
    expect(fields).toMatchObject({ query: SQL, code: "XX000" });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private/i);
  });

  it("keeps everything else as Better Auth logs it", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const problem = new Error("Rate limit reached");
    authLog("warn", "Too many attempts", { ip: "127.0.0.1" }, problem);
    const [line, details, fields] = warned.mock.calls[0]!;
    expect(line).toMatch(/ WARN \[Better Auth\]: Too many attempts$/);
    expect(details).toEqual({ ip: "127.0.0.1" });
    expect(fields).toEqual({ error: "Rate limit reached", stack: problem.stack });
  });
});
