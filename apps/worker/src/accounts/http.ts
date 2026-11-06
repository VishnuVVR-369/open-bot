/**
 * Calls to Google's APIs, with the retry rules the executor depends on: a read is retried when it
 * failed for a passing reason, and a write only when the provider certainly did nothing.
 */

/** A provider call failed. `ambiguous` means it may have happened anyway. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The request may have reached the provider and taken effect (a timeout, a reset, a 5xx). */
    readonly ambiguous: boolean,
    /** The provider's own reason, like `accessNotConfigured` or `insufficientPermissions`. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

export interface ProviderRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Reads retry passing failures; writes don't, except the ones that certainly did nothing. */
  mode: "read" | "write";
  timeoutMs?: number;
}

export interface ProviderResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** The account's current access token, and a way to get a new one after a 401. */
export interface TokenSource {
  token(): Promise<string>;
  refresh(): Promise<string>;
}

const MAX_READ_ATTEMPTS = 3;
const MAX_WAIT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Errors from fetch that mean nothing was sent: the connection never opened. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function errorCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : null;
}

function buildUrl(url: string, query: ProviderRequest["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
    else params.append(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}${url.includes("?") ? "&" : "?"}${search}` : url;
}

function retryAfterMs(headers: Headers, attempt: number): number {
  const header = headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  const wait = Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt;
  return Math.min(Math.max(wait, 200), MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Google's error body, as one readable sentence. */
function googleError(status: number, body: unknown): { message: string; reason: string | null } {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") {
    const { message, errors } = error as { message?: unknown; errors?: { reason?: unknown }[] };
    const reason =
      errors?.find((entry) => typeof entry.reason === "string")?.reason ??
      (error as { status?: unknown }).status;
    return {
      message: typeof message === "string" && message ? message : `It answered ${status}.`,
      reason: typeof reason === "string" ? reason : null,
    };
  }
  if (typeof error === "string") return { message: error, reason: error };
  return { message: `It answered ${status}.`, reason: null };
}

/**
 * One call, as JSON. A 401 gets a fresh token and one more try. Reads retry 429, 5xx and
 * connection failures with backoff (honouring Retry-After), up to 3 attempts. Writes retry only
 * a 429 or a connection that never opened, since those certainly did nothing.
 */
export async function providerJson<T>(
  tokens: TokenSource,
  request: ProviderRequest,
): Promise<ProviderResponse<T>> {
  const url = buildUrl(request.url, request.query);
  let token = await tokens.token();
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= MAX_READ_ATTEMPTS - 1;
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
          ...request.headers,
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const code = errorCode(error);
      const sent = !code || !NOT_SENT.has(code);
      if (!last && (request.mode === "read" || !sent)) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ProviderError(
        timedOut ? "It didn't answer in time." : `Couldn't reach it (${code ?? "network error"}).`,
        null,
        request.mode === "write" && sent,
      );
    }
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      token = await tokens.refresh();
      attempt -= 1;
      continue;
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (response.ok) return { status: response.status, body: body as T, headers: response.headers };
    const retryable =
      response.status === 429 || (request.mode === "read" && response.status >= 500);
    if (retryable && !last) {
      await sleep(retryAfterMs(response.headers, attempt));
      continue;
    }
    const { message, reason } = googleError(response.status, body);
    throw new ProviderError(
      message,
      response.status,
      // A 5xx after a write was sent may have done it; a 4xx was a definite refusal.
      request.mode === "write" && response.status >= 500,
      reason,
    );
  }
}
