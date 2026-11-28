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
 * The worker has no such route: it's from before that route, still running while a deploy
 * finishes (the web app and the worker deploy on their own, in either order). A worker answers
 * a path it doesn't know with this 404, never a feature's refusal.
 */
export const isMissingRoute = (error: unknown) =>
  error instanceof WorkerError && error.status === 404 && error.message === "not found";

/** Said when a write needs a worker route that the worker still running doesn't have yet. */
export const FINISHING_UPDATE =
  "open-bot is finishing an update, so nothing changed. Try again in a minute.";

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
