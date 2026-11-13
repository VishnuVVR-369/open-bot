// What specs that change app-wide state (your settings, your accounts) use to leave it as it was,
// even when two runs share one app. Tested against Postgres by scripts/test/e2e-shared-state.test.mjs.
import type pg from "pg";

/**
 * Takes a lock that every run against this database shares, for a suite that changes what the
 * whole app shares, so two runs never change it at once. It's held on its own connection until
 * the returned release, or until the process ends. Answers null, without waiting, when another
 * run holds it: the suite then skips.
 */
export async function suiteLock(
  pool: pg.Pool,
  name: string,
): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const key = `open-bot e2e ${name}`;
  try {
    const { rows } = await client.query<{ held: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as held",
      [key],
    );
    if (!rows[0]?.held) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
    } finally {
      client.release();
    }
  };
}

/** What a plan spec writes, so only that is undone. */
export interface PlanChanges {
  /**
   * The hint of the API key the spec saves (`testApiKey()`), which carries the run's tag: saving
   * a key keeps the row's other columns, so the hint is what tells the spec's key from yours.
   */
  keyHint: string;
  /** The monthly caps the spec sets. */
  caps: number[];
}

/**
 * Notes the OpenAI API key and the plan settings (limit and monthly cap) a spec is about to change,
 * and returns how to put them back, or null when another run is testing them. It holds the
 * plan-settings lock until then. Only what the spec wrote is undone: its own key (by `keyHint`)
 * gives way to yours, and the cap goes back only if it's still one the spec set. A key or cap you
 * save meanwhile stays, and a key you remove stays removed. The plan's limit always goes back: the
 * spec simulates one, so it can't tell it from a real one that starts during the run, which the
 * worker records again on the next turn that hits it.
 */
export async function savePlanSettings(
  pool: pg.Pool,
  changes: PlanChanges,
): Promise<(() => Promise<void>) | null> {
  const release = await suiteLock(pool, "plan settings");
  if (!release) return null;
  try {
    const {
      rows: [plan],
    } = await pool.query<{ plan_limited_until: Date | null; monthly_cap_micros: string }>(
      "select plan_limited_until, monthly_cap_micros from settings where id = 1",
    );
    const { rows: keys } = await pool.query<Record<string, unknown>>(
      "select * from credentials where kind = 'openai_api_key'",
    );
    return async () => {
      try {
        if (plan) {
          await pool.query("update settings set plan_limited_until = $1 where id = 1", [
            plan.plan_limited_until,
          ]);
          await pool.query(
            "update settings set monthly_cap_micros = $1 where id = 1 and monthly_cap_micros = any($2::bigint[])",
            [plan.monthly_cap_micros, changes.caps],
          );
        }
        // Yours comes back only in place of the spec's: if you removed it meanwhile, it stays gone.
        const removed = await pool.query(
          "delete from credentials where kind = 'openai_api_key' and hint = $1",
          [changes.keyHint],
        );
        if (removed.rowCount)
          for (const row of keys) {
            const columns = Object.keys(row);
            await pool.query(
              `insert into credentials (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (kind) do nothing`,
              Object.values(row),
            );
          }
      } finally {
        await release();
      }
    };
  } catch (error) {
    await release();
    throw error;
  }
}
