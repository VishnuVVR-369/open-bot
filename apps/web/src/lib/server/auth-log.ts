import "server-only";
import { errorFields } from "@open-bot/db";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Better Auth's log lines, as its default logger writes them, but with every error as
 * `errorFields`: a failed query's own error repeats its parameters, such as a new user's name
 * and email, and Better Auth logs it whole.
 */
export function authLog(level: Level, message: string, ...args: unknown[]): void {
  const safe = args.map((arg) => (arg instanceof Error ? errorFields(arg) : arg));
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  write(`${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`, ...safe);
}
