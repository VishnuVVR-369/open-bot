import "server-only";
import { errorMessage } from "@open-bot/db";
import { NextResponse } from "next/server";
import { crossSiteRefusal } from "./origin";
import { sessionOrNull } from "./session";
import { WorkerError } from "./worker";

/**
 * Wrap a route handler: require the owner's session, refuse writes from other sites, and turn
 * errors into JSON responses.
 */
export function authed<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const refused = crossSiteRefusal(args[0]);
    if (refused) return refused;
    const session = await sessionOrNull();
    if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    try {
      return await handler(...args);
    } catch (error) {
      const status = error instanceof WorkerError ? error.status : 500;
      return NextResponse.json({ error: errorMessage(error) }, { status });
    }
  };
}
