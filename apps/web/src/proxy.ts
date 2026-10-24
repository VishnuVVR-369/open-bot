import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/** Optimistic check: send visitors without a session cookie to sign in. Pages still verify the session. */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // The installable app's manifest, icons and service worker load before you sign in.
  matcher: [
    "/((?!api|_next|login|setup|icon.svg|favicon.ico|manifest.webmanifest|sw.js|icons/).*)",
  ],
};
