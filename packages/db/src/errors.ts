// Failed queries without the values in them.
// A query's parameters can hold anything a person typed (message text, names, tokens), and
// anything may log a failed query's error whole: our own code, and frameworks that log an error
// nobody caught (Next.js, Better Auth). So values are taken out where the errors are made:
// - Drizzle's `DrizzleQueryError` never keeps the parameters (`patches/drizzle-orm@*.patch`).
// - Every client of a pool from `createPool` rebuilds Postgres's own error without them (below).
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";

/**
 * SQLSTATE classes whose messages name only things (tables, columns, constraints, types,
 * locks), never a value. A data exception (22), a raised exception (P0), an internal error
 * (XX) and anything not listed can quote the value it refused, so its message is replaced.
 */
const NAMING_CLASSES = new Set([
  "08", // connection
  "0A", // feature not supported
  "23", // integrity constraint: the value itself is only in `detail`
  "25", // transaction state
  "28", // authorization
  "3D", // database missing
  "3F", // schema missing
  "40", // rollback: serialization failure, deadlock
  "42", // syntax or access rule: names identifiers and types
  "53", // insufficient resources
  "54", // program limit
  "55", // object not in prerequisite state, lock not available
  "57", // operator intervention: a canceled statement, a shutdown
  "58", // system error
]);

/**
 * What a Postgres error keeps: where it happened and what it names. `detail`, `where`, `hint`
 * and `internalQuery` are dropped, since they can repeat a row or a parameter.
 */
const NAMING_FIELDS = [
  "severity",
  "code",
  "position",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "file",
  "line",
  "routine",
] as const;

/** Postgres's error, rebuilt with only what can't hold a value. Anything else is returned as is. */
export function withoutValues<T>(error: T): T | pg.DatabaseError {
  if (!(error instanceof pg.DatabaseError)) return error;
  const code = error.code ?? "unknown";
  const message = NAMING_CLASSES.has(code.slice(0, 2))
    ? error.message
    : `The database refused the query (SQLSTATE ${code}).`;
  const safe = new pg.DatabaseError(message, error.length, error.name);
  for (const field of NAMING_FIELDS) safe[field] = error[field];
  // Where it was thrown, under the new message: the old stack starts with the old message.
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  safe.stack = [`${safe.name}: ${message}`, ...frames].join("\n");
  return safe;
}

type Callback = (error: Error | null | undefined, result?: unknown) => void;

/**
 * A client whose failed queries fail with `withoutValues(error)`, for the promise and the
 * callback forms (the pool's own `query` uses the callback). A submittable query (a cursor or a
 * stream) reports errors through its own events, out of reach, so it is refused.
 */
export class SafeClient extends pg.Client {
  // The overloads of `query` can't be written as one signature, so this takes them loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(config: any, values?: any, callback?: any): any {
    if (typeof config?.submit === "function")
      throw new TypeError("open-bot's pools don't run submittable queries.");
    const done: Callback | undefined =
      typeof values === "function"
        ? values
        : typeof callback === "function"
          ? callback
          : typeof config?.callback === "function"
            ? config.callback
            : undefined;
    const given = typeof values === "function" ? undefined : values;
    if (done)
      return super.query(config, given, (error: Error | null | undefined, result: unknown) =>
        done(withoutValues(error), result),
      );
    return super.query(config, given).catch((error: unknown) => {
      throw withoutValues(error);
    });
  }
}

/** Drizzle's error for a failed query, also when a bundler loaded a second copy of Drizzle. */
function failedQuery(error: unknown): DrizzleQueryError | undefined {
  if (error instanceof DrizzleQueryError) return error;
  if (error instanceof Error && error.name === "DrizzleQueryError" && "query" in error)
    return error as DrizzleQueryError;
  return undefined;
}

/**
 * The database's own error behind Drizzle's `DrizzleQueryError`, whose message is the failed SQL.
 * Rethrow this to fail with what the database said. Anything else is returned as is.
 */
export function databaseError(error: unknown): unknown {
  const failed = failedQuery(error);
  if (!failed) return error;
  return failed.cause instanceof Error ? failed.cause : new Error("A database query failed.");
}

/**
 * An error's message for a person or a log. A failed query says what the database said, without
 * values (`withoutValues`), and never its SQL.
 */
export function errorMessage(error: unknown): string {
  const shown = withoutValues(databaseError(error));
  return shown instanceof Error ? shown.message : String(shown);
}

/**
 * An error as a log line records it. A failed query gives its message, its SQL and what the
 * database's error names (code, table, column, constraint). Any other error keeps its stack.
 */
export function errorFields(error: unknown): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = { error: errorMessage(error) };
  const failed = failedQuery(error);
  const shown = databaseError(error);
  if (failed) fields.query = failed.query;
  if (shown instanceof pg.DatabaseError)
    Object.assign(fields, {
      code: shown.code,
      table: shown.table,
      column: shown.column,
      constraint: shown.constraint,
    });
  else if (!failed && error instanceof Error) fields.stack = error.stack;
  return fields;
}
