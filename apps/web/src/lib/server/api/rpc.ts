import "server-only";
import { API_ERRORS, contract } from "@open-bot/api";
import { errorFields, errorMessage } from "@open-bot/db";
import { MemoryError } from "@open-bot/memory";
import { implement, ORPCError, ValidationError } from "@orpc/server";
import { z } from "zod";
import { auth } from "../auth";
import { WorkerError } from "../worker";
import { ApiError } from "./errors";

export interface RpcContext {
  headers: Headers;
}

/** The code for a failure that only has an HTTP status, from the worker or the memory store. */
const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  503: "SERVICE_UNAVAILABLE",
};

/** Errors as callers see them: the same messages the web shows, with a code to act on. */
function toRpcError(error: unknown): ORPCError<string, unknown> {
  // Input the contract refused: say what the schema says ("Name the chat."), not that it failed.
  if (
    error instanceof ORPCError &&
    error.code === "BAD_REQUEST" &&
    error.cause instanceof ValidationError
  )
    return new ORPCError("BAD_REQUEST", {
      message: error.cause.issues.map((issue) => issue.message).join(". "),
      data: error.data,
      cause: error.cause,
    });
  if (error instanceof ORPCError) return error;
  if (error instanceof ApiError) {
    // A defined error only counts as one with the status the contract gives it.
    const status = error.code === "BAD_REQUEST" ? 400 : API_ERRORS[error.code].status;
    return new ORPCError(error.code, {
      status,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
  }
  if (error instanceof z.ZodError)
    return new ORPCError("BAD_REQUEST", { message: error.issues.map((i) => i.message).join(". ") });
  if (error instanceof WorkerError || error instanceof MemoryError) {
    const code = STATUS_CODES[error.status] ?? "INTERNAL_SERVER_ERROR";
    // A 409 here is a state conflict (STATE_CONFLICT), never a reused id (CONFLICT).
    return new ORPCError(code === "CONFLICT" ? "STATE_CONFLICT" : code, {
      status: error.status,
      message: error.message,
    });
  }
  // Never the error itself: a failed query's repeats its parameters.
  console.error("rpc failed", errorFields(error));
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error) });
}

/**
 * Builds the API's procedures, signed in: each feature implements its part of the contract with
 * it, and `router.ts` puts them together.
 */
export const os = implement(contract)
  .$context<RpcContext>()
  .use(async ({ context, next }) => {
    const session = await auth.api.getSession({ headers: context.headers });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
    try {
      return await next({ context: { user: session.user, sessionId: session.session.id } });
    } catch (error) {
      throw toRpcError(error);
    }
  });
