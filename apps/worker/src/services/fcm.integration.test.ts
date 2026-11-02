import { createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, createPool, nativePushDevices } from "@open-bot/db";
import type { Context, NotificationEvent } from "../context";
import { FcmService } from "./fcm";

const url = process.env.MOBILE_API_TEST_DATABASE_URL;

interface Sent {
  token: string;
  data: Record<string, string>;
  android: { priority: string; ttl: string; collapse_key?: string };
}

/** Phone notifications through a stand-in for Google's token endpoint and the FCM v1 API. */
describe.skipIf(!url)("FCM fan-out", () => {
  const pool = createPool(url ?? "postgres://unused");
  const db = createDb(pool);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sent: Sent[] = [];
  /** Tokens the stand-in says were unregistered. */
  const gone = new Set<string>();
  let tokenRequests = 0;

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      if (request.url === "/token") {
        tokenRequests += 1;
        const assertion = new URLSearchParams(body).get("assertion") ?? "";
        const [header, claims, signature] = assertion.split(".");
        const valid = createVerify("RSA-SHA256")
          .update(`${header}.${claims}`)
          .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
        const scope = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()).scope;
        if (!valid || scope !== "https://www.googleapis.com/auth/firebase.messaging") {
          response.writeHead(400).end(JSON.stringify({ error_description: "bad assertion" }));
          return;
        }
        response.end(JSON.stringify({ access_token: "fcm-access", expires_in: 3600 }));
        return;
      }
      if (request.url === "/v1/projects/open-bot-test/messages:send") {
        if (request.headers.authorization !== "Bearer fcm-access") {
          response.writeHead(401).end("{}");
          return;
        }
        const { message } = JSON.parse(body) as { message: Sent };
        if (gone.has(message.token)) {
          response.writeHead(404).end(
            JSON.stringify({
              error: {
                status: "NOT_FOUND",
                details: [
                  {
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    errorCode: "UNREGISTERED",
                  },
                ],
              },
            }),
          );
          return;
        }
        sent.push(message);
        response.end(JSON.stringify({ name: "projects/open-bot-test/messages/1" }));
        return;
      }
      response.writeHead(404).end();
    });
  });

  let fcm: FcmService;
  const events = new EventEmitter();

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_mobile_api_test")
      throw new Error(
        "Use the disposable openbot_mobile_api_test database (pnpm test:mobile-api).",
      );
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../../../packages/db/drizzle", import.meta.url)),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ctx = {
      db,
      pool,
      events,
      env: {
        FCM_API_BASE_URL: base,
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          project_id: "open-bot-test",
          client_email: "worker@open-bot-test.iam.gserviceaccount.com",
          private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
          token_uri: `${base}/token`,
        }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Context;
    fcm = new FcmService(ctx);
    fcm.start();
  });
  beforeEach(async () => {
    await db.delete(nativePushDevices);
    sent.length = 0;
    gone.clear();
  });
  afterAll(async () => {
    server.close();
    await pool.end();
  });

  const approval: NotificationEvent = {
    id: "8d1f8f8e-0000-4000-8000-000000000001",
    kind: "approval",
    title: "Rex needs your approval",
    body: "Buy **the flight** for [$420](https://example.com)",
    botId: "b1",
    chatId: "c1",
    runId: "r1",
    approvalId: "a1",
    approvalKind: "purchase",
  };

  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(predicate()).toBe(true);
  }

  it("sends approvals to every phone as urgent data messages the app renders itself", async () => {
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9" });
    await fcm.register({ token: "phone-2", platform: "android", device: "Pixel 8" });
    events.emit("notification", approval);
    await until(() => sent.length === 2);

    expect(sent.map((message) => message.token).sort()).toEqual(["phone-1", "phone-2"]);
    expect(sent[0]!.android).toEqual({ priority: "HIGH", ttl: "3600s" });
    expect(sent[0]!.data).toEqual({
      type: "notification",
      kind: "approval",
      title: "Rex needs your approval",
      body: "Buy the flight for $420",
      tag: "a1",
      url: "/approvals/a1",
      botId: "b1",
      chatId: "c1",
      runId: "r1",
      approvalId: "a1",
      approvalNeedsBiometric: "true",
    });
    // The access token is fetched once and reused.
    const before = tokenRequests;
    events.emit("notification", { ...approval, id: "n2" });
    await until(() => sent.length === 4);
    expect(tokenRequests).toBe(before);
  });

  it("sends replies at normal priority, opening the chat at the run", async () => {
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9" });
    events.emit("notification", {
      id: "n3",
      kind: "run_finished",
      title: "Rex replied",
      body: "word ".repeat(100),
      botId: "b1",
      chatId: "c1",
      runId: "r1",
    } satisfies NotificationEvent);
    await until(() => sent.length === 1);
    expect(sent[0]!.android.priority).toBe("NORMAL");
    expect(sent[0]!.data).toMatchObject({ url: "/chats/c1?run=r1", tag: "r1" });
    expect(sent[0]!.data.body).toHaveLength(180);
    expect(sent[0]!.data).not.toHaveProperty("approvalId");
  });

  it("removes an approval's notification once it's decided anywhere", async () => {
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9" });
    events.emit("approvalDecided", "a1");
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      data: { type: "dismiss", tag: "a1" },
      android: { priority: "NORMAL" },
    });
  });

  it("forgets phones FCM says are unregistered", async () => {
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9" });
    await fcm.register({ token: "phone-old", platform: "android", device: "Old phone" });
    gone.add("phone-old");
    expect(await fcm.sendAll({ data: { type: "dismiss", tag: "x" }, priority: "normal" })).toBe(1);
    const devices = await db.select().from(nativePushDevices);
    expect(devices.map((device) => device.token)).toEqual(["phone-1"]);
    expect(devices[0]!.lastSentAt).not.toBeNull();
  });

  it("keeps one row per phone when it registers again", async () => {
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9" });
    await fcm.register({ token: "phone-1", platform: "android", device: "Pixel 9 Pro" });
    const devices = await db.select().from(nativePushDevices);
    expect(devices).toEqual([expect.objectContaining({ token: "phone-1", device: "Pixel 9 Pro" })]);
    await fcm.unregister("phone-1");
    expect(await db.select().from(nativePushDevices)).toEqual([]);
  });
});
