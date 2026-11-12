// What specs that change app-wide state (your settings, your accounts) use to leave it as it was,
// even when two runs share one app. Tested against Postgres by scripts/test/e2e-shared-state.test.mjs.
import type pg from "pg";

/**
 * Takes a lock that every run against this database shares, for a suite that changes what the
 * whole app shares, so two runs never change it at once. It's held on its own connection until
 * the returned release, or until the process ends. With `wait: false` it answers null when
 * another run holds it.
 */
export async function suiteLock(
  pool: pg.Pool,
  name: string,
  { wait }: { wait: boolean },
): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const key = `open-bot e2e ${name}`;
  try {
    const { rows } = await client.query<{ held: boolean }>(
      wait
        ? "select true as held from pg_advisory_lock(hashtext($1))"
        : "select pg_try_advisory_lock(hashtext($1)) as held",
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

/**
 * Notes the OpenAI API key and the plan settings (limit and monthly cap) a spec is about to change,
 * and returns how to put them back, so a run on your app leaves yours as they were. It holds the
 * plan-settings lock until then, so runs sharing the app take turns. The spec's own key
 * (`keyHint`, like `sk-…1234`) is removed and yours put back only where no other key took its
 * place: a key you save meanwhile stays.
 */
export async function savePlanSettings(
  pool: pg.Pool,
  keyHint: string,
): Promise<() => Promise<void>> {
  const release = (await suiteLock(pool, "plan settings", { wait: true }))!;
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
        if (plan)
          await pool.query(
            "update settings set plan_limited_until = $1, monthly_cap_micros = $2 where id = 1",
            [plan.plan_limited_until, plan.monthly_cap_micros],
          );
        await pool.query("delete from credentials where kind = 'openai_api_key' and hint = $1", [
          keyHint,
        ]);
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
