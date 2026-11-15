// Test helper: making the database refuse new runs, as during a deploy whose
// migration renamed what a run refers to. Only tests import this file.
import type { Pool } from "pg";

/** Every insert into `runs` fails, with the error a renamed table gives, until `allowRunsIn`. */
export async function refuseRunsIn(pool: Pool): Promise<void> {
  await pool.query(`
    create or replace function refuse_runs() returns trigger language plpgsql as $$
    begin raise exception using errcode = '42P01', message = 'relation "bots" does not exist'; end $$; -- vocabulary: allow
    drop trigger if exists refuse_runs on runs;
    create trigger refuse_runs before insert on runs for each row execute function refuse_runs();
  `);
}

export async function allowRunsIn(pool: Pool): Promise<void> {
  await pool.query("drop trigger if exists refuse_runs on runs");
}
