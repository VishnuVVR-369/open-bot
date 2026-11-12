import { createWorkerClient } from "@open-bot/api/worker";
import pg from "pg";
import { e2eStack, TEST_TEAMMATE_NAME } from "./stack";

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

/** Remove what the tests created (teammates, chats, screens, workspaces, uploads) so they don't clutter your app. */
export default async function globalTeardown() {
  const { databaseUrl, workerUrl } = e2eStack();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  /** Cleanup is best effort: a worker that is down leaves nothing to clean on the computer. */
  const worker = createWorkerClient({
    url: workerUrl,
    secret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
  });
  try {
    await pool.query("delete from chats where kind = 'group' and title = 'E2E group'");
    await pool.query("delete from skills where name like 'e2e-%'");
    await pool.query("delete from notifications where title like 'E2E %'");
    await pool.query("delete from uploads where name like 'e2e-%'");
    await pool.query("delete from vault_items where name like 'E2E %'");
    await pool.query("delete from connections where label like 'E2E %'");
    // Pages outlive their teammate, so the tests' go first.
    await pool.query(
      "delete from pages where title like 'E2E %' or bot_id in (select id from bots where name ~ $1)",
      [TEST_TEAMMATE_NAME.source],
    );
    // Helpers' screens go when their part is done; these are from runs that were cut short.
    const helpers = await pool.query<{ id: string }>(
      "select t.id from swarm_tasks t join swarms s on s.id = t.swarm_id join bots b on b.id = s.bot_id where b.name ~ $1",
      [TEST_TEAMMATE_NAME.source],
    );
    for (const { id } of helpers.rows) await forgetScreen(id);
    const { rows } = await pool.query<{ id: string; slug: string }>(
      "delete from bots where name ~ $1 returning id, slug",
      [TEST_TEAMMATE_NAME.source],
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
