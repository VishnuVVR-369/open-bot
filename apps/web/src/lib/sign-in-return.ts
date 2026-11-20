/**
 * Where sign-in sends you back to. A signed-out visit to a page goes to `/login?next=<the page>`,
 * and a successful sign-in goes to `next`. The value comes from the URL, so anyone can write one:
 * `safeNext()` keeps it to a page of this app, or answers home.
 */

/** The query parameter that carries the page to return to. */
export const NEXT_PARAM = "next";

/**
 * The request header the proxy sets to the page asked for (path and query), so a server component
 * that finds the session gone can send you to sign in with it. Layouts aren't given the URL.
 */
export const REQUESTED_PAGE_HEADER = "x-open-bot-requested-page";

const HOME = "/";
const MAX_LENGTH = 2048;
/** Any base works: a path that keeps it as its origin stays on whatever origin serves the app. */
const BASE = "http://open-bot.invalid";
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Pages that lead back to sign-in, or aren't pages. */
const REFUSED = [/^\/login(\/|$)/, /^\/setup(\/|$)/, /^\/api(\/|$)/];

/**
 * `value` if it's a page of this app (a path, with its query and hash), otherwise `/`.
 * Refuses another origin in any spelling (`//evil.com`, `/\\evil.com`, `https://evil.com`,
 * `javascript:`, or one that normalizing makes, like `/.//evil.com`), control characters (encoded
 * or not), and the sign-in pages and the API.
 */
export function safeNext(value: string | null | undefined): string {
  const page = checked(value);
  // Normalizing can turn a path into another host's: `/.//evil.com` and `/a/..//evil.com` become
  // `//evil.com`. So what it returns must pass unchanged too, and that is what the browser follows.
  return page !== undefined && checked(page) === page ? page : HOME;
}

/** `value` normalized (dot segments resolved), if it passes every check before normalizing. */
function checked(value: string | null | undefined): string | undefined {
  if (!value || value.length > MAX_LENGTH) return undefined;
  // A path, and not one a browser reads as another host: `//host` and `/\\host` both are.
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  if (value.includes("\\") || CONTROL.test(value)) return undefined;
  const decoded = decodeFully(value);
  if (CONTROL.test(decoded) || decoded.startsWith("//") || decoded.startsWith("/\\"))
    return undefined;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== BASE) return undefined;
  const path = decodeFully(url.pathname).toLowerCase();
  if (REFUSED.some((pattern) => pattern.test(path))) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The sign-in page (or first-time setup) that returns to `page` afterwards. Home needs no `next`,
 * so a plain visit keeps the plain `/login`.
 */
export function signInPath(page: string | null | undefined, to: "/login" | "/setup" = "/login") {
  const next = safeNext(page);
  return next === HOME ? to : `${to}?${new URLSearchParams({ [NEXT_PARAM]: next })}`;
}

/**
 * Percent-decodes until nothing changes, so double encoding can't hide anything. A lone `%` (as in
 * `?q=100%25`, once decoded) stays as it is instead of failing the whole value.
 */
function decodeFully(value: string): string {
  let current = value;
  for (let round = 0; round < 10; round++) {
    const next = current.replace(/(%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === current) return current;
    current = next;
  }
  return current;
}
