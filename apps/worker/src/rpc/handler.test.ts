import http from "node:http";
import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient, workerContract, type WorkerMeta } from "@open-bot/api/worker";
import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { createHttpServer, type HttpDeps } from "../http";
import { MAX_BODY_BYTES } from "./handler";
import { BotError } from "../services/bots";
import { EmailError } from "../services/email";
import { ScreenBusy } from "../services/screen-lock";
import { TriggerError } from "../services/triggers";

const SECRET = "handler-test-secret";
const ID = "6f1c1f3e-8a5b-4c39-9a51-1c1e1d0f0a01";
const OPERATION = {
  id: ID,
  takeoverId: ID,
  screenId: ID,
  status: "safe" as const,
  reason: null,
};

/**
 * The worker's HTTP transport with stand-in services: which procedures wake the computer, how
 * errors come back, and that callers written before the contract (raw JSON on the same paths)
 * still work, since the web app and the worker deploy separately.
 */
describe("worker internal API transport", () => {
  /** What the computer was woken for, and the signal it was woken with. */
  const woken: { reason: string; signal?: AbortSignal }[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    env: { WORKER_SECRET: SECRET },
    log,
    lifecycle: {
      run: vi.fn(async (reason: string, work: () => Promise<unknown>, signal?: AbortSignal) => {
        woken.push({ reason, signal });
        return work();
      }),
    },
    computer: { online: false, health: null, startScreen: vi.fn(async () => ({})) },
    codex: {
      status: { connected: false, authSource: "host", account: null, login: null, error: null },
      rateLimits: vi.fn(async (): Promise<unknown> => null),
    },
  } as unknown as Context;
  const services = {
    ctx,
    teammates: {
      findTeammate: vi.fn(async (id: string) => ({ id })),
      update: vi.fn(async () => {
        throw new BotError(409, "This teammate was changed since it was loaded.");
      }),
    },
    egress: { status: OFFLINE_EGRESS_STATUS },
    files: {
      list: vi.fn(async (path = "/home/bot/shared") => ({ path, entries: [] })),
      write: vi.fn(async () => {}),
    },
    tasks: { update: vi.fn(async () => ({})) },
    triggers: {
      setEnabled: vi.fn(async () => {
        throw new TriggerError("That watch no longer exists.");
      }),
    },
    email: {
      inbound: vi.fn(async (token: string) => {
        if (token !== "known-token") throw new EmailError("unknown address");
        return { botId: ID };
      }),
    },
    screenOperations: {
      type: vi.fn(async (): Promise<typeof OPERATION> => OPERATION),
    },
    uploads: {
      status: vi.fn(async () => null),
      put: vi.fn(async (input: { id: string; name: string; data: Buffer }) => ({
        id: input.id,
        status: "complete" as const,
        attachment: { name: input.name, path: "/home/bot/shared/uploads/x", mime: "", size: 0 },
      })),
    },
    schedules: {
      runNow: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    },
  } as unknown as HttpDeps;

  let server: http.Server;
  let url: string;
  const client = () => createWorkerClient({ url, secret: SECRET });
  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { "x-worker-secret": SECRET, "content-type": "application/json", ...init.headers },
    });

  beforeAll(async () => {
    server = createHttpServer(services);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    woken.length = 0;
    log.error.mockClear();
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("gives every procedure its own path under /internal", () => {
    const routes: string[] = [];
    const walk = (node: object) => {
      for (const value of Object.values(node)) {
        const route = (value as { "~orpc"?: { route: { method: string; path: string } } })["~orpc"]
          ?.route;
        if (route) routes.push(`${route.method} ${route.path}`);
        else walk(value as object);
      }
    };
    walk(workerContract);
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.every((route) => /^(GET|POST) \/internal\//.test(route))).toBe(true);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("wakes the computer only for procedures that need it, named by the request path", async () => {
    // Status must never wake the computer: it reports whether it is awake.
    await client().status.get();
    await expect(client().uploads.status({ uploadId: ID })).rejects.toThrow();
    expect(woken).toEqual([]);

    await client().screens.wake({ screenId: ID });
    await client().files.list({});
    expect(woken.map((entry) => entry.reason)).toEqual([
      `/internal/screens/${ID}/wake`,
      "/internal/files/list",
    ]);
  });

  it("marks exactly the procedures that touch the computer", () => {
    const waking: string[] = [];
    const walk = (node: object, path: string[]) => {
      for (const [key, value] of Object.entries(node)) {
        const orpc = (value as { "~orpc"?: { meta: WorkerMeta } })["~orpc"];
        if (orpc) {
          if (orpc.meta.wakesComputer) waking.push([...path, key].join("."));
        } else walk(value as object, [...path, key]);
      }
    };
    walk(workerContract, []);
    // A procedure added here needs a reason: it keeps a sleeping computer awake.
    expect(waking.sort()).toEqual(
      [
        "codex.deviceLogin",
        "codex.logout",
        "codex.setAuthSource",
        "connections.test",
        "files.list",
        "files.put",
        "files.read",
        "files.remove",
        "files.write",
        "pages.publish",
        "screens.forget",
        "screens.handBack",
        "screens.take",
        "screens.touch",
        "screens.typeCode",
        "screens.wake",
        "takeovers.codeContext",
        "teammates.sync",
      ].sort(),
    );
  });

  it("stops waiting for the computer when the caller gives up", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    vi.mocked(services.files.write).mockImplementationOnce(async () => {
      started();
      await new Promise(() => {});
    });
    const call = client().files.write(
      { path: "/home/bot/shared/a.txt", dataBase64: "" },
      { context: { timeoutMs: 60_000 }, signal: AbortSignal.timeout(200) },
    );
    await expect(call).rejects.toThrow();
    await running;
    const { signal } = woken.at(-1)!;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("sends each service error as its status and message", async () => {
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected a failure");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(ORPCError);
          const { status, message, code } = error as ORPCError<string, unknown>;
          return { status, message, code };
        },
      );
    expect(
      await failure(
        client().teammates.update({
          teammateId: ID,
          changes: { name: "Ada" },
          expected_revision: "1",
        }),
      ),
    ).toEqual({
      status: 409,
      code: "CONFLICT",
      message: "This teammate was changed since it was loaded.",
    });
    expect(
      await failure(client().triggers.setEnabled({ triggerId: ID, enabled: true })),
    ).toMatchObject({ status: 400, message: "That watch no longer exists." });
    expect(await failure(client().uploads.status({ uploadId: ID }))).toMatchObject({
      status: 404,
      message: "That upload isn't here.",
    });
    // Input that doesn't fit the contract says what's wrong, in the schema's words.
    expect(
      await failure(client().files.put({ dir: "/home/bot", name: "", dataBase64: "" })),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    // Anything unexpected is a 500, logged with the path.
    expect(await failure(client().schedules.runNow({ scheduleId: ID }))).toMatchObject({
      status: 500,
      message: "connection reset",
    });
    expect(log.error).toHaveBeenCalledWith("request failed", {
      path: `/internal/schedules/${ID}/run`,
      error: "connection reset",
    });
  });

  it("never echoes a one-time code's request back, even in a validation error", async () => {
    const input = {
      takeoverId: ID,
      operationId: ID,
      expectedSite: "example.com",
      pressEnter: false,
      text: "12345",
    };
    await expect(client().screens.typeCode(input)).resolves.toEqual(OPERATION);
    const invalid = await client()
      .screens.typeCode({ ...input, text: "12x45" })
      .catch((error: unknown) => error as ORPCError<string, unknown>);
    expect(invalid).toMatchObject({
      status: 400,
      message: "That code request is invalid. Nothing was typed.",
    });
    vi.mocked(services.screenOperations.type).mockRejectedValueOnce(new ScreenBusy());
    const busy = await client()
      .screens.typeCode(input)
      .catch((error: unknown) => error as ORPCError<string, unknown>);
    expect(busy).toMatchObject({
      status: 500,
      message: "Code entry outcome unknown. Check the screen.",
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("answers callers written before the contract the same way", async () => {
    expect((await fetch(`${url}/internal/status`)).status).toBe(401);
    expect((await raw("/internal/nothing-here")).status).toBe(404);
    // A POST without a body, but with a JSON content type, like the old web app sent.
    expect(await (await raw(`/internal/screens/${ID}/wake`, { method: "POST" })).json()).toEqual({
      ok: true,
    });
    // Path parameters and the JSON body make the input.
    const update = await raw(`/internal/tasks/${ID}`, {
      method: "POST",
      body: JSON.stringify({ status: "done" }),
    });
    expect(update.status).toBe(200);
    expect(services.tasks.update).toHaveBeenLastCalledWith(ID, { status: "done" });
    // GET input comes from the query string.
    const list = await raw(`/internal/files/list?path=${encodeURIComponent("/home/bot/shared")}`);
    expect(await list.json()).toEqual({ path: "/home/bot/shared", entries: [] });
    // Errors carry `error`, the message the old web app shows.
    const conflict = await raw(`/internal/triggers/${ID}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toMatchObject({ error: "That watch no longer exists." });
    // Postmark's payload is the whole body, whatever keys it has.
    const mail = await raw("/internal/email/inbound/known-token", {
      method: "POST",
      body: JSON.stringify({ token: "not the path's", Subject: "Hi" }),
    });
    expect(await mail.json()).toEqual({ ok: true, botId: ID });
    expect(services.email.inbound).toHaveBeenLastCalledWith("known-token", {
      token: "not the path's",
      Subject: "Hi",
    });
    const unknown = await raw("/internal/email/inbound/other", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "Not found." });
  });

  it("reads an old worker's errors, which have only a message", async () => {
    const old = await import("node:http").then(({ createServer }) =>
      createServer((_request, response) => {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "That run is still going." }));
      }),
    );
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    try {
      const port = (old.address() as AddressInfo).port;
      const error = await createWorkerClient({ url: `http://127.0.0.1:${port}`, secret: SECRET })
        .runs.retry({ runId: ID })
        .catch((failure: unknown) => failure as ORPCError<string, unknown>);
      expect(error).toMatchObject({ status: 409, message: "That run is still going." });
    } finally {
      await new Promise<void>((resolve) => old.close(() => resolve()));
    }
  });

  it("streams an upload's raw bytes outside the contract, keeping the computer awake", async () => {
    const response = await fetch(`${url}/internal/uploads/${ID}`, {
      method: "PUT",
      headers: {
        "x-worker-secret": SECRET,
        "content-type": "application/octet-stream",
        "x-upload-name": encodeURIComponent("notes.md"),
        "x-upload-size": "5",
        "x-upload-sha256": "ABC",
      },
      body: "hello",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: ID, status: "complete" });
    expect(services.uploads.put).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: ID, name: "notes.md", size: 5, sha256: "abc" }),
    );
    expect(woken.map((entry) => entry.reason)).toEqual([`/internal/uploads/${ID}`]);
    const unnamed = await fetch(`${url}/internal/uploads/${ID}`, {
      method: "PUT",
      headers: { "x-worker-secret": SECRET, "x-upload-size": "1", "x-upload-sha256": "a" },
      body: "x",
    });
    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toMatchObject({ error: "The file needs a name." });
  });
  it("sends ChatGPT's usage windows in the shape web apps read before the contract", async () => {
    const window = { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_700_000_000 };
    expect(await client().codex.rateLimits()).toEqual({ rateLimits: null });
    // Codex's whole response, of which the web app shows the two windows.
    vi.mocked(ctx.codex.rateLimits).mockResolvedValue({
      ordinaryUsageAllowed: true,
      accountId: "account",
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      rateLimitUpsell: null,
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        credits: null,
        primary: window,
        secondary: null,
      },
    } as never);
    const expected = { rateLimits: { rateLimits: { primary: window, secondary: null } } };
    expect(await client().codex.rateLimits()).toEqual(expected);
    const response = await raw("/internal/codex/rate-limits");
    expect(await response.json()).toEqual(expected);
    expect(woken).toEqual([]);
  });

  /**
   * Sends a body over the limit without waiting to finish writing it, since the worker may answer
   * and close the connection first: `declared` says its size up front, otherwise it is chunked.
   */
  function oversized(declared: boolean) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = http.request(`${url}/internal/files/write`, {
        method: "POST",
        headers: {
          "x-worker-secret": SECRET,
          "content-type": "application/json",
          ...(declared ? { "content-length": String(MAX_BODY_BYTES + 1) } : {}),
        },
      });
      request.on("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          request.destroy();
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        });
      });
      // Writes after the worker has answered can fail; the answer is what is checked.
      request.on("error", () => {});
      request.on("close", () => reject(new Error("closed without an answer")));
      const chunk = Buffer.alloc(1024 * 1024, 32);
      let sent = 0;
      const write = () => {
        while (sent <= MAX_BODY_BYTES && !request.destroyed) {
          sent += chunk.length;
          if (!request.write(chunk)) return void request.once("drain", write);
        }
      };
      request.write("{");
      if (declared) return;
      write();
    });
  }

  it("refuses a body over the limit with a 413, and keeps serving", async () => {
    const writes = vi.mocked(services.files.write).mock.calls.length;
    for (const declared of [true, false]) {
      const answer = await oversized(declared);
      expect(answer).toEqual({
        status: 413,
        body: { error: expect.any(String), code: "PAYLOAD_TOO_LARGE" },
      });
    }
    expect(vi.mocked(services.files.write).mock.calls.length).toBe(writes);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const broken = await raw("/internal/files/write", { method: "POST", body: "{" });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ code: "BAD_REQUEST" });
  });
});
