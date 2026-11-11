import { LOCKS, withTryLock } from "@open-bot/db";
import type { Context } from "../context";

export class ScreenBusy extends Error {
  constructor(message = "The screen is busy. Check it before trying again.") {
    super(message);
  }
}

/** A session lock spans botd calls without holding a database transaction open. */
export async function withScreenLock<T>(
  ctx: Pick<Context, "pool">,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  return withTryLock(ctx.pool, LOCKS.screen(id), () => new ScreenBusy(), action);
}
