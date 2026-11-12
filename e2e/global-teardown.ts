import { createWorkerClient } from "@open-bot/api/worker";
import pg from "pg";
import { e2eStack, RUN_TAG, runTag, TEST_LABEL, TEST_SLUG, testTeammateName } from "./stack";

/**
 * Attachments the run uploaded are named with `testSlug()`, behind the prefix uploads get: 8
 * characters for ones saved from email or Telegram, the upload id for ones the apps upload.
 */
const testUploads = (tag: string) =>
  new RegExp(
    `^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-e2e-${tag}-`,
  );

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
 * Remove what the run created (teammates, chats, screens, workspaces, uploads) so it doesn't
 * clutter your app. Only what carries this run's tag goes, so nothing of yours, and nothing another
 * run is making at the same time, can match; what an interrupted run left stays until you delete it.
 */
export default async function globalTeardown() {
  // Global setup tags the run. Without a tag nothing is provably the run's.
  if (!process.env[RUN_TAG]) return;
  const tag = runTag();
  const { databaseUrl, workerUrl } = e2eStack();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  /** Cleanup is best effort: a worker that is down leaves nothing to clean on the computer. */
  const worker = createWorkerClient({
    url: workerUrl,
    secret: process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
  });
  try {
    // Each query's parameters start with the run's pattern for that table.
    const label = [TEST_LABEL(tag)];
    const slug = [TEST_SLUG(tag)];
    const teammates = [testTeammateName(tag).source];
    const theirs = "select id from bots where name ~ $1";
    await pool.query("delete from chats where kind = 'group' and title like $1", label);
    await pool.query("delete from skills where name like $1", slug);
    await pool.query("delete from notifications where title like $1", label);
    await pool.query("delete from uploads where name like $1", slug);
    await pool.query("delete from vault_items where name like $1", label);
    await pool.query("delete from connections where label like $1", label);
    // Pages outlive their teammate, so the run's go first.
    await pool.query(`delete from pages where title like $2 or bot_id in (${theirs})`, [
      ...teammates,
      ...label,
    ]);
    // Helpers' screens go when their part is done; these are from runs that were cut short.
    const helpers = await pool.query<{ id: string }>(
      `select t.id from swarm_tasks t join swarms s on s.id = t.swarm_id where s.bot_id in (${theirs})`,
      teammates,
    );
    for (const { id } of helpers.rows) await forgetScreen(id);
    const { rows } = await pool.query<{ id: string; slug: string }>(
      `delete from bots where id in (${theirs}) returning id, slug`,
      teammates,
    );
    for (const { id, slug } of rows) {
      await forgetScreen(id);
      await worker.files.remove({ path: `/home/bot/bots/${slug}` }).catch(() => {});
    }
    const uploads = await worker.files.list({ path: "/home/bot/shared/uploads" }).catch(() => null);
    for (const entry of uploads?.entries ?? []) {
      if (testUploads(tag).test(entry.name))
        await worker.files.remove({ path: entry.path }).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}
