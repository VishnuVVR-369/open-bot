import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { createApiClient, type ChatData } from "@open-bot/api";
import { expect, test } from "./fixtures";

const databaseUrl = process.env.POCKET_TEST_DATABASE_URL;
if (
  databaseUrl &&
  (!["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname) ||
    new URL(databaseUrl).pathname !== "/openbot_pocket_test")
) {
  throw new Error("A disposable local openbot_pocket_test database is required.");
}
const db = new pg.Pool({ connectionString: databaseUrl ?? "postgres://unused" });
const email = "pocket-e2e@example.test";
const password = "Pocket-test-password-only-2026";
const evidence = process.env.POCKET_TEST_EVIDENCE_DIR;
async function record(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, name), JSON.stringify(data, null, 2));
}
async function seedChat(count: number) {
  const teammateId = randomUUID(),
    chatId = randomUUID();
  await db.query(
    "insert into bots(id,name,slug,role,color) values($1,'Pocket Reviewer',$2,'assistant','#7C5CFF')",
    [teammateId, `pocket-${teammateId}`],
  );
  await db.query(
    "insert into chats(id,kind,title,bot_id,read_at) values($1,'direct','Pocket inbox verification',$2,now()-interval '2 days')",
    [chatId, teammateId],
  );
  const runs: string[] = [];
  for (let index = 1; index <= count; index++) {
    const id = randomUUID();
    const at = new Date(Date.now() - (count - index + 5) * 60_000).toISOString();
    const text = `Pocket report ${index}: your inbox update is ready.`;
    await db.query(
      "insert into runs(id,chat_id,bot_id,trigger,prompt,status,final_text,created_at,started_at,completed_at) values($1,$2,$3,'user','Summarize my inbox','completed',$4,$5,$5,$5)",
      [id, chatId, teammateId, text, at],
    );
    await db.query("insert into run_events(run_id,chat_id,payload) values($1,$2,$3)", [
      id,
      chatId,
      {
        type: "item",
        item: {
          id: `answer-${id}`,
          kind: "message",
          phase: "final",
          status: "completed",
          startedAt: at,
          completedAt: at,
          text,
        },
      },
    ]);
    runs.push(id);
  }
  return { teammateId, chatId, runs };
}

test.describe("isolated pocket inbox regression", () => {
  test.skip(!databaseUrl, "Use pnpm test:pocket-inbox for a disposable local stack.");

  test.beforeAll(async ({ request, baseURL }) => {
    const existing = await db.query('select id from "user"');
    if (!existing.rowCount) {
      const response = await request.post("/api/auth/sign-up/email", {
        headers: { origin: baseURL! },
        data: { name: "Pocket Owner", email, password },
      });
      expect(response.ok()).toBeTruthy();
    }
  });
  test.afterAll(async () => {
    await db.end();
  });
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("/");
  });

  test("phone API finds an older reply, pages continuously to it, and replays its later events", async ({
    page,
    context,
    baseURL,
  }) => {
    const cookie = (await context.cookies(baseURL))
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const api = createApiClient({ appUrl: baseURL!, headers: () => ({ cookie }) });
    const { teammateId, chatId, runs } = await seedChat(75);
    const target = runs[0]!;
    const notification = (
      await db.query(
        "insert into notifications(kind,title,body,bot_id,chat_id,run_id) values('run_finished','Pocket older reply','Your first report is ready',$1,$2,$3) returning id",
        [teammateId, chatId, target],
      )
    ).rows[0];
    const results = await api.search.messages({ query: "Pocket report 1:" });
    expect(results.some((result) => result.runId === target)).toBeTruthy();
    const linked = (await api.notifications.list()).find((item) => item.id === notification.id)!;
    expect(linked).toMatchObject({ chatId, runId: target, readAt: null });
    const home = await api.home.get({
      awaySince: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect(home.unreadNotifications).toBeGreaterThan(0);
    const pages: ChatData[] = [];
    let before: string | undefined;
    do {
      const data = await api.chats.get({ chatId, ...(before ? { before } : {}) });
      pages.push(data);
      before = data.entries[0]?.at;
      if (!data.hasMore) break;
    } while (pages.length < 10);
    const ids = pages.flatMap((data) =>
      data.entries.filter((entry) => entry.type === "run").map((entry) => entry.run.id),
    );
    expect(ids).toHaveLength(75);
    expect(new Set(ids).size).toBe(75);
    expect(ids).toContain(target);
    const cursor = pages[0]!.cursor;
    const event = (
      await db.query(
        "insert into run_events(run_id,chat_id,payload) values($1,$2,$3) returning id",
        [
          target,
          chatId,
          { type: "delta", itemId: `answer-${target}`, delta: " Follow-up delivered while away." },
        ],
      )
    ).rows[0];
    const replay = await page.evaluate(
      async ({ chatId, cursor, eventId }) => {
        const response = await fetch(`/api/stream?chat=${chatId}&after=${cursor}`);
        const reader = response.body!.getReader();
        let transcript = "";
        const timeout = setTimeout(() => void reader.cancel(), 15_000);
        try {
          while (!transcript.includes(`"id":${eventId},`)) {
            const part = await reader.read();
            if (part.done) break;
            transcript += new TextDecoder().decode(part.value);
          }
        } finally {
          clearTimeout(timeout);
          await reader.cancel();
        }
        return transcript;
      },
      { chatId, cursor, eventId: Number(event.id) },
    );
    expect(replay).toContain("Follow-up delivered while away.");
    expect(replay).toContain(target);
    await api.notifications.markRead({ ids: [notification.id] });
    expect(
      (await api.notifications.list()).find((item) => item.id === notification.id)?.readAt,
    ).not.toBeNull();
    await record("pocket-api-history-and-replay.json", {
      search: results,
      notification: linked,
      home,
      history: pages.map((data) => ({
        count: data.entries.length,
        first: data.entries[0]?.at,
        last: data.entries.at(-1)?.at,
        hasMore: data.hasMore,
        cursor: data.cursor,
      })),
      totalUniqueReplies: new Set(ids).size,
      replay,
    });
  });

  test("a bounded web refresh marks a newly completed reply read even when the page stays full", async ({
    page,
    context,
    baseURL,
  }) => {
    const { teammateId, chatId } = await seedChat(30);
    await page.evaluate(() => localStorage.setItem("open-bot:computer-panel", "closed"));
    await page.goto(`/chats/${chatId}`);
    await expect(page.getByTestId("run")).toHaveCount(30);
    const readAt = async () =>
      (
        await db.query("select read_at from chats where id=$1", [chatId])
      ).rows[0].read_at.getTime() as number;
    await expect.poll(readAt).toBeGreaterThan(Date.now() - 60_000);
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: path.join(evidence, "web-chat-before-bounded-refresh.png"),
        fullPage: true,
      });
    }
    const previousRead = await readAt();
    const runId = randomUUID();
    const at = new Date(Math.max(Date.now(), previousRead + 1)).toISOString();
    const text = "New pocket inbox reply arrived: your latest report is ready.";
    await db.query(
      "insert into runs(id,chat_id,bot_id,trigger,prompt,status,final_text,created_at,started_at,completed_at) values($1,$2,$3,'user','Latest inbox update','completed',$4,$5,$5,$5)",
      [runId, chatId, teammateId, text, at],
    );
    await db.query("insert into run_events(run_id,chat_id,payload) values($1,$2,$3)", [
      runId,
      chatId,
      {
        type: "item",
        item: {
          id: `answer-${runId}`,
          kind: "message",
          phase: "final",
          status: "completed",
          startedAt: at,
          completedAt: at,
          text,
        },
      },
    ]);
    const cookie = (await context.cookies(baseURL))
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    const api = createApiClient({ appUrl: baseURL!, headers: () => ({ cookie }) });
    expect((await api.chats.list()).find((chat) => chat.id === chatId)?.unread).toBe(true);
    await db.query("select pg_notify('openbot_chat',$1)", [chatId]);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByTestId("run")).toHaveCount(30);
    await expect.poll(readAt).toBeGreaterThan(previousRead);
    await expect
      .poll(async () => (await api.chats.list()).find((chat) => chat.id === chatId)?.unread)
      .toBe(false);
    if (evidence)
      await page.screenshot({
        path: path.join(evidence, "web-chat-after-bounded-refresh.png"),
        fullPage: true,
      });
    await record("web-bounded-refresh-read-state.json", {
      before: { completedRepliesShown: 30, readAt: new Date(previousRead).toISOString() },
      after: {
        completedRepliesShown: await page.getByTestId("run").count(),
        newReply: text,
        readAt: new Date(await readAt()).toISOString(),
        chat: (await api.chats.list()).find((chat) => chat.id === chatId),
      },
    });
  });
});
