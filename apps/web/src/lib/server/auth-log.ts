import "server-only";
import { errorFields, errorMessage, withoutParameters } from "@open-bot/db";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Better Auth's log lines, as its default logger writes them, but with every error as
 * `errorFields`: a failed query's own error repeats its parameters, such as a new user's name
 * and email, and Better Auth logs it whole, sometimes as the line's text (a message or the error
 * itself, despite its types).
 */
export function authLog(level: Level, message: unknown, ...args: unknown[]): void {
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const [text, details] =
    message instanceof Error
      ? [errorMessage(message), [message, ...args]]
      : [withoutParameters(String(message)), args];
  const safe = details.map((arg) => (arg instanceof Error ? errorFields(arg) : arg));
  write(`${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${text}`, ...safe);
}
