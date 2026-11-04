type CallError = { code?: unknown; message?: unknown; status?: unknown; defined?: unknown };

const callError = (error: unknown): CallError | undefined =>
  error && typeof error === "object" && "code" in error ? (error as CallError) : undefined;

/** What to tell you when a call failed: the server's own words, or that it couldn't be reached. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  const call = callError(error);
  if (call) {
    if (call.code === "INTERNAL_SERVER_ERROR") return fallback;
    // A 404 the API didn't send itself: the server answering doesn't have the phone's API.
    if (call.code === "NOT_FOUND" && call.defined === false) {
      return "This open-bot server is out of date. Deploy the latest version to use the app.";
    }
    // A failure from something in front of the API, like the host while open-bot restarts.
    if (call.defined === false && typeof call.status === "number" && call.status >= 500) {
      return "open-bot isn't answering right now. Try again in a moment.";
    }
    if (typeof call.message === "string" && call.message) return call.message;
  }
  if (error instanceof TypeError) return "Couldn't reach open-bot. Check your connection.";
  return fallback;
}

/** The server said what you asked for isn't there (archived, or deleted): asking again won't help. */
export function isGone(error: unknown): boolean {
  const call = callError(error);
  return call?.code === "NOT_FOUND" && call.defined === true;
}

export function isUnauthorized(error: unknown): boolean {
  return callError(error)?.code === "UNAUTHORIZED";
}

/**
 * Whether trying again could work: the connection dropped or the server failed. A request the
 * server turned down (signed out, gone, not allowed) fails the same way every time.
 */
export function isRetryable(error: unknown): boolean {
  const status = callError(error)?.status;
  return typeof status !== "number" || status >= 500;
}

/**
 * A file request that failed, shaped like the API's own errors: the server's words show, a
 * missing file isn't asked for again, and a lost session signs you out.
 */
export class FileError extends Error {
  readonly defined = true;
  readonly code: string;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.code =
      status === 401 ? "UNAUTHORIZED" : status >= 500 ? "INTERNAL_SERVER_ERROR" : "FILE_ERROR";
  }
}
