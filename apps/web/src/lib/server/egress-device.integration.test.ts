import http from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { randomBytes } from "node:crypto";
import { hashDeviceSecret, readToken } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = testDatabaseServer();
const WORKER_SECRET = "egress-device-test-secret";
const PHONE = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";

/**
 * A paired phone's credential, through the real route handlers against a disposable database,
 * with a stand-in worker that records what it's told. The worker pairs and unpairs phones (it owns
 * them); its own tests cover that, so here pairings are written as it would leave them.
 */
describe.skipIf(!url)("egress device credential", () => {
  const database = testDatabase(url);
  const workerCalls: { path: string; body: unknown }[] = [];
  const worker = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const path = request.url ?? "";
      workerCalls.push({ path, body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          path.endsWith("/pair") ? { secret: "from-worker", generation: 3 } : { ok: true },
        ),
      );
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
    await database.create();
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = database.url;
    process.env.WORKER_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    process.env.WORKER_SECRET = WORKER_SECRET;
    process.env.NEXT_PUBLIC_WORKER_WS_URL = "ws://worker.test";
    const [egress, token, unavailable, pushToken, db, schema] = await Promise.all([
      import("./api/egress"),
      import("@/app/api/egress/device/token/route"),
      import("@/app/api/egress/device/unavailable/route"),
      import("@/app/api/egress/device/push-token/route"),
      import("./db"),
      import("@open-bot/db"),
    ]);
    modules = { egress, token, unavailable, pushToken, db, schema };
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
    await database.drop();
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

  /** The phone paired `generation` times, with a fresh secret, as the worker leaves it. */
  async function pair(generation = 1) {
    const secret = randomBytes(32).toString("base64url");
    const values = {
      id: PHONE,
      name: "Pixel 9",
      secretHash: hashDeviceSecret(secret),
      pushToken: "fcm-1",
      generation,
      revokedAt: null,
    };
    await modules.db.db
      .insert(modules.schema.egressDevices)
      .values(values)
      .onConflictDoUpdate({ target: modules.schema.egressDevices.id, set: values });
    return { secret, generation };
  }

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
    expect(workerCalls.map((entry) => entry.path)).toContain(
      `/internal/egress/devices/${PHONE}/used`,
    );
  });

  it("answers a failed query with the database's error, never its SQL or parameters", async () => {
    const { secret } = await pair();
    const { deviceRoute } = await import("./egress-device");
    const { db, schema } = { db: modules.db.db, schema: modules.schema };
    // Postgres refuses a NUL byte in text, so the query fails with the title as a parameter.
    const route = deviceRoute(async () => {
      await db.select().from(schema.tasks).where(eq(schema.tasks.title, "a private\u0000title"));
      return new Response("unreachable");
    });
    const response = await call({ POST: route }, secret);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'invalid byte sequence for encoding "UTF8": 0x00',
    });
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

  it("refuses a secret from an earlier pairing, and a revoked phone", async () => {
    const first = await pair(1);
    const second = await pair(2);
    expect((await call(modules.token, first.secret)).status).toBe(401);
    expect((await call(modules.token, second.secret)).status).toBe(200);
    await modules.db.db.update(modules.schema.egressDevices).set({ revokedAt: new Date() });
    expect((await call(modules.token, second.secret)).status).toBe(401);
    expect(await modules.egress.listEgressDevices()).toEqual([]);
  });

  it("asks the worker to pair and unpair a phone", async () => {
    expect(
      await modules.egress.registerEgressDevice({
        deviceId: PHONE,
        name: "Pixel 9",
        pushToken: "fcm-1",
      }),
    ).toEqual({ secret: "from-worker", generation: 3 });
    await modules.egress.revokeEgressDevice({ deviceId: PHONE, generation: 3 });
    expect(workerCalls).toEqual([
      {
        path: `/internal/egress/devices/${PHONE}/pair`,
        body: { name: "Pixel 9", pushToken: "fcm-1" },
      },
      { path: `/internal/egress/devices/${PHONE}/unpair`, body: { generation: 3 } },
    ]);
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

  it("passes a new push token to the worker, and not the same one again", async () => {
    const { secret } = await pair();
    workerCalls.length = 0;
    expect((await call(modules.pushToken, secret, { token: "fcm-1" })).status).toBe(200);
    expect((await call(modules.pushToken, secret, { token: "fcm-2" })).status).toBe(200);
    expect(workerCalls).toEqual([
      { path: `/internal/egress/devices/${PHONE}/push-token`, body: { token: "fcm-2" } },
    ]);
  });
});
