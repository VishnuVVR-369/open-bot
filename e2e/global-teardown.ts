import { createWorkerClient } from "@open-bot/api/worker";
import pg from "pg";
import { e2eStack, RUN_STARTED, TEST_TEAMMATE_NAME } from "./stack";

/**
 * Attachments the tests upload are named e2e-…, behind the prefix uploads get: 8 characters for
 * ones saved from email or Telegram, the upload id for ones the apps upload.
 */
const TEST_UPLOADS =
  /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-e2e-/;

async function forgetScreen(screenId: string) {
  await fetch(`${e2eStack().botdUrl}/screens/forget`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.BOTD_TOKEN ?? "dev-botd-token-change-me"}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ screenId }),
  }).catch(() => {});
}

/**
 * Remove what the tests created (teammates, chats, screens, workspaces, uploads) so they don't
 * clutter your app. Only rows created since the run started that carry the tests' names go, so
 * nothing of yours can match; what an interrupted run left stays until you delete it.
 */
export default async function globalTeardown() {
  const { databaseUrl, workerUrl } = e2eStack();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  /** Cleanup is best effort: a worker that is down leaves nothing to clean on the computer. */
  const worker = createWorkerClient({
    url: workerUrl,
    secret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
  });
  // Global setup's note of when the run started. Without it nothing is provably the run's.
  const since = process.env[RUN_STARTED];
  try {
    if (!since) return;
    /** Runs `query` (whose last parameter is `since`) over rows created during the run only. */
    const recent = (query: string, params: unknown[] = []) =>
      pool.query(`${query} and created_at >= $${params.length + 1}`, [...params, since]);
    const teammates = "select id from bots where name ~ $1 and created_at >= $2";
    await recent("delete from chats where kind = 'group' and title = 'E2E group'");
    await recent("delete from skills where name like 'e2e-%'");
    await recent("delete from notifications where title like 'E2E %'");
    await recent("delete from uploads where name like 'e2e-%'");
    await recent("delete from vault_items where name like 'E2E %'");
    await recent("delete from connections where label like 'E2E %'");
    // Pages outlive their teammate, so the tests' go first.
    await recent(`delete from pages where (title like 'E2E %' or bot_id in (${teammates}))`, [
      TEST_TEAMMATE_NAME.source,
      since,
    ]);
    // Helpers' screens go when their part is done; these are from runs that were cut short.
    const helpers = await pool.query<{ id: string }>(
      `select t.id from swarm_tasks t join swarms s on s.id = t.swarm_id where s.bot_id in (${teammates})`,
      [TEST_TEAMMATE_NAME.source, since],
    );
    for (const { id } of helpers.rows) await forgetScreen(id);
    const { rows } = await pool.query<{ id: string; slug: string }>(
      `delete from bots where id in (${teammates}) returning id, slug`,
      [TEST_TEAMMATE_NAME.source, since],
    );
    for (const { id, slug } of rows) {
      await forgetScreen(id);
      await worker.files.remove({ path: `/home/bot/bots/${slug}` }).catch(() => {});
    }
    const uploads = await worker.files.list({ path: "/home/bot/shared/uploads" }).catch(() => null);
    for (const entry of uploads?.entries ?? []) {
      if (TEST_UPLOADS.test(entry.name))
        await worker.files.remove({ path: entry.path }).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}
