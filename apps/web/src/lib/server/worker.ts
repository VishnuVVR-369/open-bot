import "server-only";
import { serverEnv } from "./env";

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the worker's internal API. */
export async function worker<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${serverEnv.workerUrl}${path}`, {
      method,
      headers: { "x-worker-secret": serverEnv.workerSecret, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WorkerError(503, "The worker isn't running. Start it with `pnpm dev`.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new WorkerError(response.status, data.error ?? `Worker returned ${response.status}`);
  return data as T;
}
