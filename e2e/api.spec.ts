import { createApiClient, type ApiClient } from "@open-bot/api";
import { isDefinedError, safe } from "@orpc/client";
import pg from "pg";
import { expect, test } from "./fixtures";
import { createTeammate, uniqueName } from "./helpers";

/**
 * The API the phone uses (`/api/rpc`), called the way the phone calls it: with the session
 * cookie and no browser origin.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://openbot:openbot@127.0.0.1:54329/openbot";

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
    const teammate = teammates.find((bot) => bot.name === name)!;
    expect(teammate.directChatId).toBeTruthy();
    const chats = await api.chats.list();
    expect(chats.some((chat) => chat.id === teammate.directChatId)).toBe(true);

    const { chatId } = await api.chats.newDirect({ botId: teammate.id });
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
    const teammate = (await api.teammates.list()).find((bot) => bot.name === name)!;
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
