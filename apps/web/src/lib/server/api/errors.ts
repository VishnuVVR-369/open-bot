import "server-only";
import type { API_ERRORS } from "@open-bot/api";

type DefinedCode = keyof typeof API_ERRORS;

/** Codes an `ApiError` may carry beyond the contract's defined errors, with their statuses. */
export const UNDEFINED_STATUSES = {
  BAD_REQUEST: 400,
  /** What you acted on changed since you saw it, like a suggestion handled in another tab. */
  STATE_CONFLICT: 409,
} as const;

/** An expected failure, with the message you see. The API turns it into an error with this code. */
export class ApiError extends Error {
  constructor(
    readonly code: DefinedCode | keyof typeof UNDEFINED_STATUSES,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
