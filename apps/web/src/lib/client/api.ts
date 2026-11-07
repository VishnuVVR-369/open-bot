/** A failed request, with its HTTP status, so a view can tell "offline" from "broken". */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when the request failed because the computer (the worker) isn't reachable. */
export function isOffline(error: unknown): boolean {
  return error instanceof RequestError && (error.status === 503 || error.status === 502);
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 401) {
    window.location.href = "/login";
    throw new RequestError(401, "Sign in first.");
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new RequestError(response.status, data.error ?? `Request failed (${response.status})`);
  return data;
}
