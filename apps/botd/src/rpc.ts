import type { BotdMeta } from "@open-bot/api/botd";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { ORPCError, ValidationError } from "@orpc/server";
import { BodyLimitPlugin } from "@orpc/server/node";
import { ComputerBusy, type ComputeLifecycle } from "./lifecycle";
import type { BotdRouter } from "./router";

/** The largest JSON body botd takes. Typed text is the longest input, at 5,000 characters. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Serves `botdContract`. Around every procedure:
 * - one that works on the computer (`wakesComputer`) counts as activity until it is done, so the
 *   computer doesn't quiesce under it; status reads and lifecycle calls never do;
 * - whatever it throws becomes a status and a message (`toRpcError`), sent as `{ error, code }`.
 */
export function createRpcHandler(
  router: BotdRouter,
  deps: { lifecycle?: ComputeLifecycle; log: (message: string) => void },
): OpenAPIHandler<Record<never, never>> {
  return new OpenAPIHandler(router, {
    plugins: [new BodyLimitPlugin({ maxBodySize: MAX_BODY_BYTES })],
    clientInterceptors: [
      async ({ next, procedure }) => {
        const meta: BotdMeta = procedure["~orpc"].meta;
        const path = procedure["~orpc"].route.path ?? "(unknown)";
        let endActivity: (() => void) | undefined;
        try {
          if (meta.wakesComputer) endActivity = deps.lifecycle?.begin();
          return await next();
        } catch (error) {
          if (error instanceof ComputerBusy) deps.log(`[lifecycle] stayed awake: ${error.message}`);
          const failure = toRpcError(error);
          // Never log or echo what failed when the input carries a secret: it could include it.
          if (meta.secretInput) {
            if (failure.status >= 500) deps.log(`[http] ${path} failed`);
            throw maskedError(failure);
          }
          if (failure.status >= 500) deps.log(`[http] ${path} failed: ${failure.message}`);
          throw failure;
        } finally {
          endActivity?.();
        }
      },
    ],
    // `error` is the message, where workers deployed before the contract read it.
    customErrorResponseBodyEncoder: (error) => ({ error: error.message, code: error.code }),
  });
}

const CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  409: "CONFLICT",
  500: "INTERNAL_SERVER_ERROR",
};

function rpcError(status: number, message: string): ORPCError<string, undefined> {
  return new ORPCError(CODES[status] ?? CODES[500]!, { status, message });
}

/** Every error a procedure throws, as the status and message the worker sees. */
export function toRpcError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    // Input that doesn't fit the contract: say what's wrong, as the schema words it.
    if (error.cause instanceof ValidationError && error.code === "BAD_REQUEST")
      return rpcError(400, error.cause.issues.map((issue) => issue.message).join("; "));
    if (error.cause instanceof ValidationError)
      return rpcError(500, `botd's answer doesn't fit the contract: ${error.cause.message}`);
    return error;
  }
  // The computer declined to quiesce because work is still running; the worker retries later.
  if (error instanceof ComputerBusy) return rpcError(409, error.message);
  return rpcError(500, error instanceof Error ? error.message : String(error));
}

/** What a procedure whose input carries a secret says instead: its errors could repeat it. */
function maskedError(error: ORPCError<string, unknown>): ORPCError<string, undefined> {
  if (error.status === 400) return rpcError(400, "That request is invalid. Nothing was typed.");
  if (error.status < 500) return rpcError(error.status, "That request was refused.");
  return rpcError(500, "The outcome is unknown. Check the screen.");
}
