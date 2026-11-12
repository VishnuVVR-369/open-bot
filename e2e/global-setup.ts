import pg from "pg";
import { e2eStack, RUN_STARTED } from "./stack";

/**
 * Notes when the run started, by the database's clock. Teardown only removes what was created
 * since, so nothing that was there before the run can match its name patterns.
 */
export default async function globalSetup() {
  const pool = new pg.Pool({ connectionString: e2eStack().databaseUrl });
  try {
    const { rows } = await pool.query<{ now: Date }>("select now()");
    process.env[RUN_STARTED] = rows[0]!.now.toISOString();
  } finally {
    await pool.end();
  }
}
