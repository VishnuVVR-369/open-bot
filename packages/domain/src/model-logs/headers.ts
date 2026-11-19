/** Headers as Node gives them: a name may repeat, and a missing one is undefined. */
export type HeaderBag = Record<string, string | string[] | number | undefined>;

/** Parts of a header name that mean it carries a credential. Such a header is never stored. */
const SECRET_PARTS = [
  "authorization",
  "api-key",
  "apikey",
  "cookie",
  "token",
  "secret",
  "password",
  "session-key",
  "signature",
  "attestation",
];

/** Whether a header carries a credential (auth, cookies, API keys, tokens, secrets). */
export function isSecretHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_PARTS.some((part) => lower.includes(part));
}

/**
 * Usage and limit headers worth keeping per request: generic `x-ratelimit-*` and `retry-after`,
 * and ChatGPT's plan windows, credits and plan type (`x-codex-primary-used-percent`, ...).
 */
export function isRateLimitHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("ratelimit") ||
    lower.includes("rate-limit") ||
    lower === "retry-after" ||
    ["x-codex-primary-", "x-codex-secondary-", "x-codex-credits-"].some((prefix) =>
      lower.startsWith(prefix),
    ) ||
    lower === "x-codex-plan-type" ||
    lower === "x-codex-active-limit"
  );
}

function flatten(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** The headers safe to store: lowercased names, sorted, with every credential dropped. */
export function sanitizeHeaders(headers: HeaderBag): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of Object.keys(headers).sort()) {
    const value = flatten(headers[name]);
    if (value === undefined || isSecretHeader(name)) continue;
    kept[name.toLowerCase()] = value;
  }
  return kept;
}

/** Only the usage and limit headers, as `sanitizeHeaders` would keep them. */
export function rateLimitHeaders(headers: HeaderBag): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sanitizeHeaders(headers)).filter(([name]) => isRateLimitHeader(name)),
  );
}

/** One header's value, the first if it repeats. Names are matched without case. */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower || value === undefined) continue;
    return Array.isArray(value) ? value[0] : String(value);
  }
  return undefined;
}
