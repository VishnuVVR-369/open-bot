import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { REQUESTED_PAGE_HEADER, signInPath } from "./lib/sign-in-return";

/**
 * Optimistic check: send visitors without a session cookie to sign in, and back to the page they
 * asked for afterwards. Pages still verify the session, so the page asked for goes along to them.
 */
export function proxy(request: NextRequest) {
  const page = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (!getSessionCookie(request))
    return NextResponse.redirect(new URL(signInPath(page), request.url));
  // Set, never trusted from the browser: this replaces any header of the same name it sent.
  const headers = new Headers(request.headers);
  headers.set(REQUESTED_PAGE_HEADER, page);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // The installable app's manifest, icons and service worker load before you sign in, and
  // `.well-known` files (like the Android app's domain association) are public.
  matcher: [
    "/((?!api|_next|login|setup|icon.svg|favicon.ico|manifest.webmanifest|sw.js|icons/|\\.well-known/).*)",
  ],
};
