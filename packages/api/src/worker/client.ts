import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { workerContract, type WorkerContract } from "./contract";

/** Per call: `worker.files.read(input, { context: { timeoutMs: 30_000 } })`. */
export interface WorkerCallContext {
  /** Give up after this long. Defaults to `WorkerClientOptions.timeoutMs`. */
  timeoutMs?: number;
}

export type WorkerClient = ContractRouterClient<WorkerContract, WorkerCallContext>;

export interface WorkerClientOptions {
  /** Where the worker is, like `http://worker.railway.internal:4001`. */
  url: string | (() => string);
  /** `WORKER_SECRET`, sent as `x-worker-secret`. */
  secret: string | (() => string);
  /** How long a call may take unless it says otherwise. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
  /** Turn what a call throws into the caller's own error, in one place. */
  mapError?: (error: unknown) => unknown;
}

/** The header the worker checks against `WORKER_SECRET`. */
export const WORKER_SECRET_HEADER = "x-worker-secret";

const value = (option: string | (() => string)) =>
  typeof option === "function" ? option() : option;

/**
 * A typed client for the worker's internal API. Errors are `ORPCError`s with the worker's status
 * and message; a worker that can't be reached, or doesn't answer in time, throws the fetch error.
 */
export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const send = options.fetch ?? fetch;
  const { mapError } = options;
  const link = new OpenAPILink<WorkerCallContext>(workerContract, {
    url: () => value(options.url).replace(/\/+$/, ""),
    headers: () => ({ [WORKER_SECRET_HEADER]: value(options.secret) }),
    fetch: (request, init, { context }) =>
      send(request, {
        ...init,
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(context.timeoutMs ?? options.timeoutMs ?? 300_000),
        ]),
      }),
    interceptors: mapError
      ? [
          async ({ next }) => {
            try {
              return await next();
            } catch (error) {
              throw mapError(error);
            }
          },
        ]
      : [],
    // `{ error, code }` from this worker, or `{ error }` from one deployed before the contract.
    customErrorResponseBodyDecoder: (body, response) => {
      if (typeof body !== "object" || body === null || !("error" in body)) return null;
      const { error, code, data } = body as { error: unknown; code?: unknown; data?: unknown };
      if (typeof error !== "string") return null;
      return new ORPCError(typeof code === "string" ? code : "WORKER_ERROR", {
        status: response.status,
        message: error,
        data,
      });
    },
  });
  return createORPCClient(link);
}
