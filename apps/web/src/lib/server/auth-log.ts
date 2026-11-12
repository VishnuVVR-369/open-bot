import "server-only";
import { errorFields, errorMessage } from "@open-bot/db";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Better Auth's log lines, as its default logger writes them, but with every error as
 * `errorFields`: a log line keeps what the error names (a failed query's SQLSTATE, SQL, table,
 * constraint) and drops the rest. Better Auth sometimes gives the error as the line's text,
 * despite its types.
 */
export function authLog(level: Level, message: unknown, ...args: unknown[]): void {
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const [text, details] =
    message instanceof Error
      ? [errorMessage(message), [message, ...args]]
      : [String(message), args];
  const safe = details.map((arg) => (arg instanceof Error ? errorFields(arg) : arg));
  write(`${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${text}`, ...safe);
}
