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
  const client = await ctx.pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [`screen:${id}`],
    );
    locked = result.rows[0]!.locked;
    if (!locked) throw new ScreenBusy();
    return await action();
  } finally {
    try {
      if (locked)
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`screen:${id}`]);
    } finally {
      client.release();
    }
  }
}
