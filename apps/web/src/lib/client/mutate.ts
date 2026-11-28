import { ORPCError } from "@orpc/client";
import { isUnauthorized } from "./errors";
import { goToSignIn } from "./sign-in";

/**
 * What a write answered: its data, or a message to show. `refused` says the server answered no
 * (a 4xx), so nothing was done; otherwise the answer may have been lost on the way.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; refused?: boolean };

export const UNREACHABLE = "Couldn't reach open-bot. Check your connection and try again.";

/**
 * Run an API write and say how it went, so a view shows the error instead of handling a throw:
 * `const result = await attempt(api.chats.archive({ chatId }))`.
 *
 * The message is the server's own ("Name the chat."). A signed-out tab goes to sign in, like a
 * read does (`components/app/providers.tsx`), and comes back here afterwards.
 */
export async function attempt<T>(
  call: Promise<T>,
  signedOut: () => void = goToSignIn,
): Promise<Result<T>> {
  try {
    return { ok: true, data: await call };
  } catch (error) {
    if (isUnauthorized(error)) signedOut();
    return { ok: false, error: message(error), refused: refused(error) };
  }
}

function refused(error: unknown): boolean {
  return error instanceof ORPCError && error.status >= 400 && error.status < 500;
}

function message(error: unknown): string {
  if (error instanceof ORPCError) return error.message;
  // fetch itself failed: offline, or the server is restarting.
  if (error instanceof TypeError) return UNREACHABLE;
  return error instanceof Error ? error.message : String(error);
}
