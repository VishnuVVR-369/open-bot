import { MemoryError } from "@open-bot/memory";
import { ORPCError, ValidationError } from "@orpc/server";
import { WorkerError } from "../core/errors";
import { errorMessage } from "../logger";

/** The code each status a procedure fails with is sent as, next to the message. */
const CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

/** Fail a procedure with a status and a message for the owner. */
export function rpcError(status: number, message: string): ORPCError<string, undefined> {
  return new ORPCError(CODES[status] ?? CODES[500]!, { status, message });
}

/**
 * Every error a procedure throws, as the status and message the caller sees. This is the only
 * place a service's error becomes an HTTP status: a `WorkerError` (or the memory
 * package's `MemoryError`) says its own, and anything else is a fault.
 */
export function toRpcError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    // Input that doesn't fit the contract: say what's wrong, as the schema words it.
    if (error.cause instanceof ValidationError && error.code === "BAD_REQUEST")
      return rpcError(400, error.cause.issues.map((issue) => issue.message).join("; "));
    return error;
  }
  if (error instanceof WorkerError || error instanceof MemoryError)
    return rpcError(error.status, error.message);
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    status: 500,
    message: errorMessage(error),
    cause: error,
  });
}

/**
 * What a procedure whose input carries a secret (a one-time code) says instead: its errors, even
 * a validation message, could repeat part of the input.
 */
export function maskedError(error: ORPCError<string, unknown>): ORPCError<string, undefined> {
  return error.status === 400
    ? rpcError(400, "That code request is invalid. Nothing was typed.")
    : rpcError(500, "Code entry outcome unknown. Check the screen.");
}
