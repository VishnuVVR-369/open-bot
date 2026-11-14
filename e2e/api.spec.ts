import { createHash } from "node:crypto";
import { createApiClient, UPLOAD_HEADERS, type ApiClient } from "@open-bot/api";
import { isDefinedError, safe } from "@orpc/client";
import pg from "pg";
import { expect, test } from "./fixtures";
import { e2eStack, createTeammate, testLabel, testSlug, uniqueName } from "./helpers";

/**
 * The API the phone uses (`/api/rpc`), called the way the phone calls it: with the session
 * cookie and no browser origin.
 */

const baseURL = e2eStack().baseUrl;
const databaseUrl = e2eStack().databaseUrl;

function client(cookie: string | null, extra: Record<string, string> = {}): ApiClient {
  return createApiClient({
    appUrl: baseURL,
    headers: () => ({ ...(cookie ? { cookie } : {}), ...extra }),
  });
}

test.describe("the phone's API", () => {
  let api: ApiClient;
  let cookie: string;
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  test.beforeEach(async ({ context }) => {
    cookie = (await context.cookies(baseURL))
      .map((entry) => `${entry.name}=${entry.value}`)
      .join("; ");
    api = client(cookie);
  });
  test.afterAll(async () => {
    await db.end();
  });

  test("needs your session, and refuses other sites", async () => {
    const anonymous = await safe(client(null).teammates.list());
    expect(anonymous.error).toMatchObject({ code: "UNAUTHORIZED", message: "Sign in first." });

    const response = await fetch(`${baseURL}/api/rpc/teammates/list`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  test("sends a message once however often it's retried", async ({ page }) => {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const teammates = await api.teammates.list();
    const teammate = teammates.find((candidate) => candidate.name === name)!;
    expect(teammate.directChatId).toBeTruthy();
    const chats = await api.chats.list();
    expect(chats.some((chat) => chat.id === teammate.directChatId)).toBe(true);

    const { chatId } = await api.chats.newDirect({ teammateId: teammate.id });
    const input = {
      clientId: crypto.randomUUID(),
      chatId,
      text: "  Reply with just the word PONG  ",
      attachments: [],
      mentions: [],
    };
    // Retried at once (a lost response) and again later: still one message and one run.
    const [first, second] = await Promise.all([api.chats.send(input), api.chats.send(input)]);
    const third = await api.chats.send(input);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(first.text).toBe("Reply with just the word PONG");

    await expect
      .poll(async () => {
        const data = await api.chats.get({ chatId });
        return {
          messages: data.entries.filter((entry) => entry.type === "message").length,
          runs: data.entries.filter((entry) => entry.type === "run").length,
        };
      })
      .toEqual({ messages: 1, runs: 1 });
    const { rows } = await db.query("select dispatch_status from messages where client_id = $1", [
      input.clientId,
    ]);
    expect(rows).toEqual([{ dispatch_status: "dispatched" }]);

    // The same id for a different message is refused, not silently accepted.
    const reused = await safe(api.chats.send({ ...input, text: "Something else" }));
    expect(isDefinedError(reused.error) && reused.error.code).toBe("CONFLICT");

    const empty = await safe(
      api.chats.send({ ...input, clientId: crypto.randomUUID(), text: " " }),
    );
    expect(empty.error).toMatchObject({ code: "BAD_REQUEST", message: "Write a message first." });
    const missing = await safe(api.chats.get({ chatId: crypto.randomUUID() }));
    expect(isDefinedError(missing.error) && missing.error.code).toBe("NOT_FOUND");
  });

  test("decides an approval once, and says how one decided elsewhere ended", async ({ page }) => {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const teammate = (await api.teammates.list()).find((candidate) => candidate.name === name)!;
    const chatId = teammate.directChatId!;
    const {
      rows: [run],
    } = await db.query(
      `insert into runs (chat_id, bot_id, trigger, prompt, status, completed_at)
       values ($1, $2, 'user', 'Clean up', 'completed', now()) returning id`,
      [chatId, teammate.id],
    );
    const approve = async (title: string) => {
      const {
        rows: [row],
      } = await db.query(
        `insert into approvals (run_id, bot_id, chat_id, kind, title, detail, payload, item_id)
         values ($1, $2, $3, 'command', $4, 'rm -rf build', '{}', $5) returning id`,
        [run.id, teammate.id, chatId, title, crypto.randomUUID()],
      );
      return row.id as string;
    };

    const first = await approve("Delete the build folder");
    expect(await api.approvals.get({ approvalId: first })).toMatchObject({
      status: "pending",
      kind: "command",
      title: "Delete the build folder",
    });
    const decision = { approvalId: first, decision: "approved" as const, alwaysAllow: null };
    expect(await api.approvals.decide(decision)).toEqual({ status: "approved" });
    // A retry of the same decision (the phone lost the response) succeeds.
    expect(await api.approvals.decide(decision)).toEqual({ status: "approved" });
    // Denying it now, from another device, says it was approved.
    const late = await safe(api.approvals.decide({ ...decision, decision: "denied" }));
    expect(isDefinedError(late.error) && late.error.code).toBe("ALREADY_DECIDED");
    expect(late.error).toMatchObject({
      message: "This was already approved.",
      data: { status: "approved" },
    });

    const second = await approve("Delete the cache folder");
    await db.query("update approvals set status = 'expired', decided_at = now() where id = $1", [
      second,
    ]);
    const expired = await safe(
      api.approvals.decide({ approvalId: second, decision: "approved", alwaysAllow: null }),
    );
    expect(expired.error).toMatchObject({
      code: "ALREADY_DECIDED",
      data: { status: "expired" },
    });
    expect((await api.approvals.list()).map((item) => item.id)).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  /** A teammate with a finished reply in its chat, made directly in the database. */
  async function teammateWithReply(page: import("@playwright/test").Page, text = "All done.") {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const teammate = (await api.teammates.list()).find((candidate) => candidate.name === name)!;
    const chatId = teammate.directChatId!;
    const {
      rows: [run],
    } = await db.query(
      `insert into runs (chat_id, bot_id, trigger, prompt, status, final_text, started_at, completed_at)
       values ($1, $2, 'user', 'Plan the trip', 'completed', $3, now() - interval '5 seconds', now())
       returning id`,
      [chatId, teammate.id, text],
    );
    return { teammate, chatId, runId: run.id as string };
  }

  async function upload(id: string, data: Buffer, name: string, sent: Buffer = data) {
    return fetch(`${baseURL}/api/uploads/${id}`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        [UPLOAD_HEADERS.name]: encodeURIComponent(name),
        [UPLOAD_HEADERS.mime]: "text/plain",
        [UPLOAD_HEADERS.size]: String(data.length),
        [UPLOAD_HEADERS.sha256]: createHash("sha256").update(data).digest("hex"),
      },
      body: new Uint8Array(sent),
    });
  }

  test("uploads an attachment once, however often it's sent", async ({ page }) => {
    const name = uniqueName("Tess");
    await createTeammate(page, name);
    const teammate = (await api.teammates.list()).find((candidate) => candidate.name === name)!;
    const data = Buffer.from("Flight AB123 leaves at 09:40\n");
    const fileName = testSlug(`${crypto.randomUUID().slice(0, 5)}.txt`);
    const id = crypto.randomUUID();

    // Cut short on the way: refused, and nothing is kept.
    const cut = await upload(id, data, fileName, data.subarray(0, 10));
    expect(cut.status).toBe(400);
    const nothing = await safe(api.uploads.status({ uploadId: id }));
    expect(isDefinedError(nothing.error) && nothing.error.code).toBe("NOT_FOUND");

    const first = await upload(id, data, fileName);
    expect(first.status).toBe(200);
    const view = await first.json();
    expect(view).toEqual({
      id,
      status: "complete",
      attachment: {
        name: fileName,
        path: `/home/bot/shared/uploads/${id}-${fileName}`,
        mime: "text/plain",
        size: data.length,
      },
    });
    // The answer was lost and the phone sends it again: the same file.
    expect(await (await upload(id, data, fileName)).json()).toEqual(view);
    expect(await api.uploads.status({ uploadId: id })).toEqual(view);
    // A different file under the same id is refused.
    expect((await upload(id, Buffer.from("something else"), fileName)).status).toBe(409);
    // Only you can upload.
    const anonymous = await fetch(`${baseURL}/api/uploads/${crypto.randomUUID()}`, {
      method: "PUT",
      body: data,
    });
    expect(anonymous.status).toBe(401);

    // A message can carry it, but not a file that never finished uploading.
    const sent = await api.chats.send({
      clientId: crypto.randomUUID(),
      chatId: teammate.directChatId!,
      text: "Here's my flight",
      attachments: [view.attachment],
      mentions: [],
    });
    expect(sent.attachments).toEqual([view.attachment]);
    const unfinished = await safe(
      api.chats.send({
        clientId: crypto.randomUUID(),
        chatId: teammate.directChatId!,
        text: "And this",
        attachments: [{ ...view.attachment, path: "/home/bot/shared/uploads/never.txt" }],
        mentions: [],
      }),
    );
    expect(unfinished.error).toMatchObject({ code: "BAD_REQUEST" });
  });

  test("tells every device a chat was read", async ({ page }) => {
    const { chatId, runId } = await teammateWithReply(page);
    await db.query("update chats set read_at = now() - interval '1 minute' where id = $1", [
      chatId,
    ]);
    const unread = async () => (await api.chats.list()).find((chat) => chat.id === chatId)?.unread;
    expect(await unread()).toBe(true);
    await api.chats.markRead({ chatId });
    expect(await unread()).toBe(false);
    // A reply that finishes later makes it unread again.
    await db.query("update runs set completed_at = now() + interval '1 second' where id = $1", [
      runId,
    ]);
    expect(await unread()).toBe(true);
  });

  test("rates a reply, and asks for it again only once", async ({ page }) => {
    const { chatId, runId } = await teammateWithReply(page);
    await api.runs.rate({ runId, rating: "up" });
    const rating = async () =>
      (await api.chats.get({ chatId })).entries.find(
        (entry) => entry.type === "run" && entry.run.id === runId,
      );
    expect(await rating()).toMatchObject({ run: { rating: "up" } });
    await api.runs.rate({ runId, rating: null });
    expect(await rating()).toMatchObject({ run: { rating: null } });

    // "Try again with this", sent twice (the answer was lost): one request to redo it.
    const feedback = {
      runId,
      text: "Reply with just the word PONG",
      remember: false,
      redo: { clientId: crypto.randomUUID() },
    };
    await Promise.all([api.runs.feedback(feedback), api.runs.feedback(feedback)]);
    await api.runs.feedback(feedback);
    const { rows } = await db.query(
      "select text from messages where chat_id = $1 and redo_of_run_id = $2",
      [chatId, runId],
    );
    expect(rows).toEqual([{ text: "Reply with just the word PONG" }]);
    expect(await rating()).toMatchObject({ run: { rating: "down" } });
    // The same id for feedback on another reply is refused.
    const other = await teammateWithReply(page);
    const reused = await safe(api.runs.feedback({ ...feedback, runId: other.runId }));
    expect(isDefinedError(reused.error) && reused.error.code).toBe("CONFLICT");
    for (const changed of [{ text: "Something else" }, { remember: true }]) {
      const result = await safe(api.runs.feedback({ ...feedback, ...changed }));
      expect(isDefinedError(result.error) && result.error.code).toBe("CONFLICT");
    }
  });

  test("tries a failed reply again once, however often it's asked", async ({ page }) => {
    const { chatId, runId } = await teammateWithReply(page);
    await db.query("update runs set status = 'failed', prompt = $2 where id = $1", [
      runId,
      "Reply with just the word PONG",
    ]);
    const [a, b] = await Promise.all([api.runs.retry({ runId }), api.runs.retry({ runId })]);
    const c = await api.runs.retry({ runId });
    expect(b.runId).toBe(a.runId);
    expect(c.runId).toBe(a.runId);
    expect(a.runId).not.toBe(runId);
    const { rows } = await db.query("select count(*)::int as runs from runs where chat_id = $1", [
      chatId,
    ]);
    expect(rows).toEqual([{ runs: 2 }]);
    await api.runs.cancel({ runId: a.runId }).catch(() => {});
  });

  test("starts, renames and archives a group chat", async ({ page }) => {
    const names = [uniqueName("Tess"), uniqueName("Tess")];
    for (const name of names) await createTeammate(page, name);
    const ids = (await api.teammates.list())
      .filter((teammate) => names.includes(teammate.name))
      .map((teammate) => teammate.id);
    const title = testLabel("group");
    const tooFew = await safe(api.chats.createGroup({ title, teammateIds: [ids[0]!] }));
    expect(tooFew.error).toMatchObject({ code: "BAD_REQUEST" });
    const { chatId } = await api.chats.createGroup({ title, teammateIds: ids });
    const group = (await api.chats.list()).find((chat) => chat.id === chatId);
    expect(group).toMatchObject({ kind: "group", title, unread: false });
    expect(group?.memberIds.sort()).toEqual([...ids].sort());
    await api.chats.rename({ chatId, title });
    await api.chats.archive({ chatId });
    expect((await api.chats.list()).some((chat) => chat.id === chatId)).toBe(false);
  });

  test("lists notifications, and marks them read", async ({ page }) => {
    const { teammate, chatId, runId } = await teammateWithReply(page);
    const {
      rows: [row],
    } = await db.query(
      `insert into notifications (kind, title, body, bot_id, chat_id, run_id)
       values ('run_finished', $1, 'All done.', $2, $3, $4) returning id`,
      [`${teammate.name} replied`, teammate.id, chatId, runId],
    );
    const find = async () =>
      (await api.notifications.list()).find((notification) => notification.id === row.id);
    expect(await find()).toMatchObject({ kind: "run_finished", chatId, runId, readAt: null });
    expect((await api.home.get({ awaySince: null })).unreadNotifications).toBeGreaterThan(0);
    await api.notifications.markRead({ ids: [row.id] });
    expect((await find())?.readAt).not.toBeNull();
  });

  test("marks read everything up to the newest one you saw, older than the list included", async () => {
    // Dated long ago, so "this one and every older one" reaches none of your real notifications.
    const insert = async (title: string, at: string) =>
      (
        await db.query(
          `insert into notifications (kind, title, created_at)
           values ('run_failed', $1, $2) returning id`,
          [testLabel(title), at],
        )
      ).rows[0].id as string;
    const old = await insert("Too old for the list", "2000-01-01");
    const seen = await insert("The newest you saw", "2000-01-02");
    const later = await insert("Came in after", "2000-01-03");
    await api.notifications.markRead({ through: seen });
    const { rows } = await db.query(
      "select id, read_at is not null as read from notifications where id = any($1)",
      [[old, seen, later]],
    );
    const read = Object.fromEntries(rows.map((row) => [row.id, row.read]));
    expect(read).toEqual({ [old]: true, [seen]: true, [later]: false });
  });

  test("finds what was said, and briefs you on what finished while you were away", async ({
    page,
  }) => {
    const word = `zebra${crypto.randomUUID().slice(0, 6)}`;
    const { teammate, runId } = await teammateWithReply(page, `The ${word} report is ready.`);
    const results = await api.search.messages({ query: word });
    expect(results).toEqual([
      expect.objectContaining({ from: "teammate", runId, teammateId: teammate.id }),
    ]);
    expect(results[0]!.excerpt).toContain(word);
    expect(await api.search.messages({ query: "z" })).toEqual([]);

    const away = new Date(Date.now() - 60 * 60_000).toISOString();
    const home = await api.home.get({ awaySince: away });
    expect(home.briefing.some((item) => item.runId === runId)).toBe(true);
    expect(home.activity.some((item) => item.runId === runId)).toBe(true);
    expect((await api.home.get({ awaySince: null })).briefing).toEqual([]);
  });

  test("approves with always allow, and forgets the rule on request", async ({ page }) => {
    const { teammate, chatId, runId } = await teammateWithReply(page);
    const {
      rows: [approval],
    } = await db.query(
      `insert into approvals (run_id, bot_id, chat_id, kind, title, detail, payload, item_id)
       values ($1, $2, $3, 'command', 'Run the tests', '$ pnpm test', $4, $5)
       returning id`,
      [runId, teammate.id, chatId, { subject: "pnpm test --run" }, crypto.randomUUID()],
    );
    expect(await api.approvals.get({ approvalId: approval.id })).toMatchObject({
      subject: "pnpm test --run",
      askEveryTime: false,
    });
    await api.approvals.decide({
      approvalId: approval.id,
      decision: "approved",
      alwaysAllow: { pattern: "pnpm test" },
    });
    const rule = (await api.approvals.rules()).find((entry) => entry.teammateId === teammate.id);
    expect(rule).toMatchObject({ kind: "command", pattern: "pnpm test" });
    await api.approvals.removeRule({ ruleId: rule!.id });
    expect((await api.approvals.rules()).some((entry) => entry.teammateId === teammate.id)).toBe(
      false,
    );
  });

  test("registers a phone for notifications", async () => {
    const token = `e2e-${crypto.randomUUID()}`;
    await api.push.registerDevice({ token, platform: "android", device: "Pixel 9" });
    await api.push.registerDevice({ token, platform: "android", device: "Pixel 9" });
    const { rows } = await db.query("select device from native_push_devices where token = $1", [
      token,
    ]);
    expect(rows).toEqual([{ device: "Pixel 9" }]);
    await api.push.unregisterDevice({ token });
    const after = await db.query("select 1 from native_push_devices where token = $1", [token]);
    expect(after.rowCount).toBe(0);
  });
});

test("serves the Android app's domain association publicly", async ({ browser }) => {
  // A fresh context: no session cookie, like Google's verifier.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const response = await context.request.get("/.well-known/assetlinks.json", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(Array.isArray(await response.json())).toBe(true);
  await context.close();
});
