import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { readToken } from "@open-bot/shared/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.MOBILE_API_TEST_DATABASE_URL;
const WORKER_SECRET = "egress-device-test-secret";
const PHONE = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";

/**
 * A paired phone's credential, through the real route handlers and services against a
 * disposable database, with a stand-in worker that records what it's told.
 */
describe.skipIf(!url)("egress device credential", () => {
  const workerCalls: { path: string; body: unknown }[] = [];
  const worker = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      workerCalls.push({ path: request.url ?? "", body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });

  let modules: {
    egress: typeof import("./api/egress");
    token: typeof import("@/app/api/egress/device/token/route");
    unavailable: typeof import("@/app/api/egress/device/unavailable/route");
    pushToken: typeof import("@/app/api/egress/device/push-token/route");
    db: typeof import("./db");
    schema: typeof import("@open-bot/db");
  };

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/openbot_mobile_api_test")
      throw new Error(
        "Use the disposable openbot_mobile_api_test database (pnpm test:mobile-api).",
      );
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = url;
    process.env.WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    process.env.WORKER_SECRET = WORKER_SECRET;
    process.env.NEXT_PUBLIC_WORKER_WS_URL = "ws://worker.test";
    const [egress, token, unavailable, pushToken, db, schema, migrator] = await Promise.all([
      import("./api/egress"),
      import("@/app/api/egress/device/token/route"),
      import("@/app/api/egress/device/unavailable/route"),
      import("@/app/api/egress/device/push-token/route"),
      import("./db"),
      import("@open-bot/db"),
      import("drizzle-orm/node-postgres/migrator"),
    ]);
    modules = { egress, token, unavailable, pushToken, db, schema };
    await migrator.migrate(db.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../../packages/db/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await modules.db.db.delete(modules.schema.egressDevices);
    await modules.db.db
      .insert(modules.schema.computers)
      .values({ id: "default", phoneEgress: "always" })
      .onConflictDoUpdate({ target: modules.schema.computers.id, set: { phoneEgress: "always" } });
    workerCalls.length = 0;
  });
  afterAll(async () => {
    worker.close();
    await modules?.db.pool.end();
  });

  function call(
    route: { POST: (request: Request) => Promise<Response> },
    secret: string,
    body?: unknown,
    device = PHONE,
  ) {
    return route.POST(
      new Request("http://web.test/api/egress/device", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-device-id": device,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  const pair = () =>
    modules.egress.registerEgressDevice({ deviceId: PHONE, name: "Pixel 9", pushToken: "fcm-1" });

  it("issues a phone token with its identity and generation, and the server's phone mode", async () => {
    const { secret, generation } = await pair();
    expect(generation).toBe(1);
    const response = await call(modules.token, secret);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      token: string;
      phoneMode: string;
      generation: number;
    };
    expect(body).toMatchObject({
      url: "ws://worker.test/egress/agent",
      phoneMode: "always",
      generation: 1,
    });
    expect(readToken(body.token, "egress", WORKER_SECRET)?.agent).toEqual({
      kind: "phone",
      id: PHONE,
      name: "Pixel 9",
      generation: 1,
    });
    const [row] = await modules.db.db.select().from(modules.schema.egressDevices);
    expect(row!.lastUsedAt).not.toBeNull();
    expect(row!.secretHash).not.toContain(secret);
  });

  it("answers 401 revoked for a wrong secret, an unknown phone and a missing header", async () => {
    await pair();
    for (const response of [
      await call(modules.token, "wrong"),
      await call(modules.token, "wrong", undefined, "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0aff"),
      await call(modules.token, "", undefined, "not-a-uuid"),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "revoked" });
    }
  });

  it("rotates the secret on pairing again, so the old one and its generation stop working", async () => {
    const first = await pair();
    workerCalls.length = 0;
    const second = await pair();
    expect(second.generation).toBe(2);
    expect((await call(modules.token, first.secret)).status).toBe(401);
    expect((await call(modules.token, second.secret)).status).toBe(200);
    // The worker drops a connection the first pairing may still have open.
    expect(workerCalls).toContainEqual({
      path: `/internal/egress/devices/${PHONE}/revoked`,
      body: { generation: 1 },
    });
  });

  it("revokes only the generation asked for, and tells the worker", async () => {
    await pair();
    const { secret } = await pair();
    workerCalls.length = 0;
    // A deferred revoke meant for the first pairing must not touch the second.
    await modules.egress.revokeEgressDevice({ deviceId: PHONE, generation: 1 });
    expect((await call(modules.token, secret)).status).toBe(200);
    expect(workerCalls).toEqual([]);

    await modules.egress.revokeEgressDevice({ deviceId: PHONE, generation: 2 });
    expect((await call(modules.token, secret)).status).toBe(401);
    expect(workerCalls).toContainEqual({
      path: `/internal/egress/devices/${PHONE}/revoked`,
      body: { generation: 2 },
    });
    const [row] = await modules.db.db.select().from(modules.schema.egressDevices);
    expect(row!.pushToken).toBeNull();
    expect(await modules.egress.listEgressDevices()).toEqual([]);
  });

  it("forwards an unavailable report with the pairing's generation and its number", async () => {
    const { secret } = await pair();
    workerCalls.length = 0;
    expect((await call(modules.unavailable, secret, { reason: "low-battery" })).status).toBe(200);
    expect((await call(modules.unavailable, secret, { reason: "stopped", seq: 3 })).status).toBe(
      200,
    );
    expect(workerCalls).toEqual([
      {
        path: `/internal/egress/devices/${PHONE}/unavailable`,
        body: { reason: "low-battery", generation: 1 },
      },
      {
        path: `/internal/egress/devices/${PHONE}/unavailable`,
        body: { reason: "stopped", generation: 1, seq: 3 },
      },
    ]);
    expect((await call(modules.unavailable, secret, { reason: "bored" })).status).toBe(400);
    expect((await call(modules.unavailable, secret, { reason: "stopped", seq: -1 })).status).toBe(
      400,
    );
  });

  it("stores a new push token and tells the worker", async () => {
    const { secret } = await pair();
    workerCalls.length = 0;
    expect((await call(modules.pushToken, secret, { token: "fcm-2" })).status).toBe(200);
    const [row] = await modules.db.db.select().from(modules.schema.egressDevices);
    expect(row!.pushToken).toBe("fcm-2");
    expect(workerCalls.map((entry) => entry.path)).toEqual(["/internal/egress/devices/changed"]);
  });
});
