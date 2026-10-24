import pg from "pg";

const TEST_BOT_NAMES = /^(Tess|Ava|Ben|Ivy|Ora|Sol|Scr|Held|Free|Ann|Bob|Alw)[a-z0-9]{4}( \d+)?$/;
/** Attachments the tests upload are named e2e-…, behind the 8-character prefix uploads get. */
const TEST_UPLOADS = /^[0-9a-f]{8}-e2e-/;

const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:4001";
const botdUrl = process.env.BOTD_URL ?? "http://127.0.0.1:7070";

async function worker<T>(path: string, body?: unknown): Promise<T | null> {
  const response = await fetch(`${workerUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-worker-secret": process.env.WORKER_SECRET ?? "dev-worker-secret-change-me",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  return response?.ok ? ((await response.json()) as T) : null;
}

async function forgetScreen(screenId: string) {
  await fetch(`${botdUrl}/screens/forget`, {
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
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot",
  });
  try {
    await pool.query("delete from chats where kind = 'group' and title = 'E2E group'");
    await pool.query("delete from skills where name like 'e2e-%'");
    await pool.query("delete from vault_items where name like 'E2E %'");
    await pool.query("delete from connections where label like 'E2E %'");
    // Helpers' screens go when their part is done; these are from runs that were cut short.
    const helpers = await pool.query<{ id: string }>(
      "select t.id from swarm_tasks t join swarms s on s.id = t.swarm_id join bots b on b.id = s.bot_id where b.name ~ $1",
      [TEST_BOT_NAMES.source],
    );
    for (const { id } of helpers.rows) await forgetScreen(id);
    const { rows } = await pool.query<{ id: string; slug: string }>(
      "delete from bots where name ~ $1 returning id, slug",
      [TEST_BOT_NAMES.source],
    );
    for (const { id, slug } of rows) {
      await forgetScreen(id);
      await worker("/internal/files/remove", { path: `/home/bot/bots/${slug}` });
    }
    const uploads = await worker<{ entries: { name: string; path: string }[] }>(
      `/internal/files/list?path=${encodeURIComponent("/home/bot/shared/uploads")}`,
    );
    for (const entry of uploads?.entries ?? []) {
      if (TEST_UPLOADS.test(entry.name))
        await worker("/internal/files/remove", { path: entry.path });
    }
  } finally {
    await pool.end();
  }
}
