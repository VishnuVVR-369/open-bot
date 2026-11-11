import "server-only";
import type { API_ERRORS } from "@open-bot/api";

/**
 * An expected failure, with the message you see. The API turns it into the contract's error with
 * this code, or a `BAD_REQUEST`.
 */
export class ApiError extends Error {
  constructor(
    readonly code: keyof typeof API_ERRORS | "BAD_REQUEST",
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
