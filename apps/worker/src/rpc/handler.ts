import type { WorkerMeta } from "@open-bot/api/worker";
import { failedQuery } from "@open-bot/db";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { BodyLimitPlugin } from "@orpc/server/node";
import type { Context } from "../context";
import { errorMessage } from "../logger";
import { maskedError, toRpcError } from "./errors";
import type { RpcContext, WorkerRouter } from "./router";

/** The largest JSON body: a file of up to 40 MB, written as base64. */
export const MAX_BODY_BYTES = 60 * 1024 * 1024;

/**
 * Serves the worker's internal API at its `/internal/...` paths. Around every procedure:
 * - one that needs the computer (`wakesComputer`) wakes it, and keeps it awake until it is done;
 *   a request the web app gives up on stops waiting for the computer;
 * - whatever it throws becomes a status and a message (`toRpcError`), sent as `{ error, code }`.
 */
export function createRpcHandler(
  router: WorkerRouter,
  ctx: Pick<Context, "lifecycle" | "log">,
): OpenAPIHandler<RpcContext> {
  return new OpenAPIHandler<RpcContext>(router, {
    plugins: [new BodyLimitPlugin({ maxBodySize: MAX_BODY_BYTES })],
    clientInterceptors: [
      async ({ next, procedure, context, signal }) => {
        const meta: WorkerMeta = procedure["~orpc"].meta;
        try {
          return meta.wakesComputer && ctx.lifecycle
            ? await ctx.lifecycle.run(context.path, next, signal)
            : await next();
        } catch (error) {
          const failure = toRpcError(error);
          // Never log or echo what failed when the input carries a code: it could include it.
          if (meta.secretInput) throw maskedError(failure);
          if (failure.status >= 500)
            ctx.log.error("request failed", {
              path: context.path,
              error: errorMessage(error),
              query: failedQuery(error),
            });
          throw failure;
        }
      },
    ],
    // `error` is the message to show, where callers deployed before the contract read it.
    customErrorResponseBodyEncoder: (error) => ({
      error: error.message,
      code: error.code,
      ...(error.data === undefined ? {} : { data: error.data }),
    }),
  });
}
