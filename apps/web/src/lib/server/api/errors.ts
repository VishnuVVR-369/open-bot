import "server-only";
import type { API_ERRORS } from "@open-bot/api";

type DefinedCode = keyof typeof API_ERRORS;

/**
 * An expected failure, with the message you see. The API turns it into a typed error with this
 * code; server actions show the message.
 */
export class ApiError extends Error {
  constructor(
    readonly code: DefinedCode | "BAD_REQUEST",
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
