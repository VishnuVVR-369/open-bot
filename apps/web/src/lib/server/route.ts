import "server-only";
import { NextResponse } from "next/server";
import { sessionOrNull } from "./session";
import { WorkerError } from "./worker";

/** Wrap a route handler: require the owner's session and turn errors into JSON responses. */
export function authed<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const session = await sessionOrNull();
    if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    try {
      return await handler(...args);
    } catch (error) {
      const status = error instanceof WorkerError ? error.status : 500;
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status },
      );
    }
  };
}
