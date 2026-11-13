import { LOCKS, withTryLock } from "@open-bot/db";
import type { Context } from "../../context";
import { WorkerError } from "../../core/errors";

export class ScreenBusy extends WorkerError {
  constructor(message = "The screen is busy. Check it before trying again.") {
    super(409, message);
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
