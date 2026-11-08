import "server-only";
import { createWorkerClient, type WorkerClient } from "@open-bot/api/worker";
import { ORPCError } from "@orpc/server";
import { serverEnv } from "./env";

/** A worker call that failed: the worker's status and its message for the owner. */
export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The worker's internal API (`workerContract`), typed end to end. Calls take 5 minutes at most
 * unless they say otherwise, like `worker.status.get(undefined, { context: { timeoutMs: 2_500 } })`.
 * Every failure is a `WorkerError`; one that can't reach the worker, or times out, is a 503.
 */
export const worker: WorkerClient = createWorkerClient({
  url: () => serverEnv.workerUrl,
  secret: () => serverEnv.workerSecret,
  fetch: (request, init) => fetch(request, { ...init, cache: "no-store" }),
  mapError: (error) => {
    if (error instanceof ORPCError) return new WorkerError(error.status, error.message);
    return new WorkerError(
      503,
      "The operation did not respond in time. Check its status before trying again.",
    );
  },
});
