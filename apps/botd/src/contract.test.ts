import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { BotdError, createBotdClient, type BotdClient } from "@open-bot/api/botd";
import type { ComputerHealth, PageCheckResult } from "@open-bot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EgressRouter } from "@open-bot/egress/router";
import { DesktopLease } from "./lease";
import { ComputeLifecycle } from "./lifecycle";
import type { PageChecker } from "./pages";
import type { ScreenManager } from "./screen-manager";
import type { Screen } from "./screens";
import { createServer } from "./server";

// botd's HTTP API driven the way the worker drives it: through `createBotdClient`, which checks
// every answer against `botdContract`.

const TOKEN = "test-token";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const HEALTH: ComputerHealth = {
  ok: true,
  bootedAt: "2026-11-08T00:00:00.000Z",
  agent: "running",
  screens: [],
  egress: { mode: "off", agentOnline: false, tunnelConnected: false, configured: true },
};

const CHECKED: PageCheckResult = {
  ok: true,
  htmlBase64: Buffer.from("<title>Hi</title>").toString("base64"),
  size: 17,
  sha256: "0".repeat(64),
  title: "Hi",
  text: "",
  issues: [{ level: "warning", message: "No text" }],
  screenshots: { phone: "", desktop: "" },
  thumbnail: "",
  thumbnailDark: "",
};

function fakeScreen(id: string): Screen {
  const lease = new DesktopLease();
  return {
    id,
    lease,
    status: () => ({ id, state: "running", browser: "running", lease: lease.holder }),
    codeSite: async () => "github.com",
  } as unknown as Screen;
}

async function start(
  options: {
    lifecycle?: ComputeLifecycle;
    health?: () => ComputerHealth;
    pages?: Partial<PageChecker>;
    codeAvailable?: boolean;
  } = {},
) {
  const running = new Map<string, Screen>();
  const log = vi.fn<(message: string) => void>();
  const screens = Object.assign(new EventEmitter(), {
    get: (id: string) => running.get(id),
    list: () => [...running.values()].map((screen) => screen.status()),
    ensure: vi.fn(async (id: string) => {
      const screen = running.get(id) ?? fakeScreen(id);
      running.set(id, screen);
      return screen;
    }),
    forget: vi.fn(async (id: string) => void running.delete(id)),
    claim: <T>(_id: string, use: () => Promise<T>) => use(),
    touch: () => {},
    releaseRun: vi.fn(() => false),
    codeAvailable: () => options.codeAvailable ?? true,
    typeCode: vi.fn(async () => ({ status: "safe" as const, reason: null })),
  }) as unknown as ScreenManager;
  const { server } = createServer({
    token: TOKEN,
    lifecycle: options.lifecycle,
    screens,
    egress: { noteDemand: () => {} } as unknown as EgressRouter,
    health: options.health ?? (() => HEALTH),
    codexUrl: "ws://127.0.0.1:9",
    pages: (options.pages ?? {}) as PageChecker,
    log,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const botd: BotdClient = createBotdClient({ url, token: TOKEN });
  return { botd, url, screens, running, log };
}

async function rejection(promise: Promise<unknown>): Promise<BotdError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BotdError);
  return error as BotdError;
}

describe("botd contract", () => {
  it("answers every status and lifecycle procedure in the contract's shape", async () => {
    const lifecycle = new ComputeLifecycle(true, {
      start: async () => {},
      stop: async () => {},
      busy: async () => false,
    });
    const { botd } = await start({ lifecycle });
    expect(await botd.healthz()).toEqual({ ok: true });
    expect(await botd.health()).toEqual(HEALTH);
    expect(await botd.lifecycle.capabilities()).toEqual({
      version: 1,
      enabled: true,
      phase: "idle",
    });
    expect(await botd.lifecycle.lease({ owner: "worker", demand: 1 })).toMatchObject({
      phase: "idle",
    });
    expect(await botd.lifecycle.ensure({ owner: "worker" })).toMatchObject({ phase: "awake" });
    await botd.lifecycle.lease({ owner: "worker", demand: 0 });
    expect(await botd.lifecycle.quiesce({ owner: "worker" })).toMatchObject({ phase: "idle" });
  });

  it("says the lifecycle is off without one, and refuses lifecycle calls with 409", async () => {
    const { botd } = await start();
    expect(await botd.lifecycle.capabilities()).toEqual({ version: 1, enabled: false });
    const error = await rejection(botd.lifecycle.ensure({ owner: "worker" }));
    expect(error.status).toBe(409);
    expect(error.detail).toBe("Lifecycle disabled");
  });

  it("drives screens and leases end to end", async () => {
    const { botd, screens } = await start();
    const screenId = randomUUID();
    expect(await botd.screens.start({ screenId })).toEqual({
      id: screenId,
      state: "running",
      browser: "running",
      lease: null,
    });
    const taken = await botd.leases.take({ screenId });
    expect(taken.previous).toBeNull();
    expect(taken.holder).toMatchObject({ kind: "user" });
    expect(await botd.leases.touch({ screenId })).toMatchObject({ holder: { kind: "user" } });
    expect(await botd.computer.codeContext({ screenId })).toEqual({ site: "github.com" });
    expect(await botd.leases.release({ screenId, reason: "user_idle" })).toEqual({
      released: true,
    });
    expect(await botd.leases.releaseRun({ runId: "run-1" })).toEqual({ released: false });
    expect(screens.releaseRun).toHaveBeenCalledWith("run-1");
    expect(await botd.screens.forget({ screenId })).toEqual({ ok: true });
    // A screen that isn't running holds nothing, so there is nothing to release.
    expect(await botd.leases.release({ screenId })).toEqual({ released: true });
    expect(await botd.computer.codeContext({ screenId })).toEqual({ site: null });
  });

  it("refuses to take a screen with 409 while a code is being typed there", async () => {
    const { botd } = await start({ codeAvailable: false });
    const error = await rejection(botd.leases.take({ screenId: randomUUID() }));
    expect(error.status).toBe(409);
    expect(error.detail).toBe("Code entry is in progress.");
  });

  it("checks pages and returns the checker's answer", async () => {
    const check = vi.fn(async () => CHECKED);
    const { botd } = await start({ pages: { check } });
    expect(await botd.pages.check({ path: "/home/bot/shared/a.html" })).toEqual(CHECKED);
    expect(check).toHaveBeenCalledWith("/home/bot/shared/a.html");
  });

  it("answers a teammate's mistakes as results, and a malformed call as 400", async () => {
    const { botd } = await start();
    const run = { runId: randomUUID(), botId: randomUUID(), botName: "Ada" };
    expect(await botd.computer.fill({ run, secret: "", site: null })).toEqual({
      ok: false,
      code: "invalid_action",
      message: "Nothing to fill",
    });
    const error = await rejection(
      botd.computer.action({
        run: { ...run, botId: "not-a-screen" },
        action: { action: "screenshot" },
      }),
    );
    expect(error.status).toBe(400);
    expect(error.detail).toBe("Unknown screen");
  });

  it("never echoes or logs a one-time code", async () => {
    const { botd, screens, log } = await start();
    const input = {
      screenId: randomUUID(),
      takeoverId: randomUUID(),
      operationId: randomUUID(),
      expectedSite: "github.com",
      pressEnter: true,
    };
    const invalid = await rejection(botd.computer.type({ ...input, text: "12345678901" }));
    expect(invalid.status).toBe(400);
    expect(invalid.message).not.toContain("12345678901");
    vi.mocked(screens.typeCode).mockRejectedValueOnce(new Error("xdotool failed typing 424242"));
    const failed = await rejection(botd.computer.type({ ...input, text: "424242" }));
    expect(failed.status).toBe(500);
    expect(failed.message).not.toContain("424242");
    expect(log.mock.calls.flat().join("\n")).not.toContain("424242");
  });

  it("checks botd's own answers, so a drifted one fails there instead of in the worker", async () => {
    const { botd, log } = await start({
      health: () => ({ ...HEALTH, agent: "dreaming" }) as unknown as ComputerHealth,
    });
    const error = await rejection(botd.health());
    expect(error.status).toBe(500);
    expect(log.mock.calls.flat().join("\n")).toContain("/health failed");
  });

  it("needs the token everywhere except the liveness check, and says 404 as JSON", async () => {
    const { url } = await start({ health: () => ({ ...HEALTH, ok: false }) });
    expect((await fetch(`${url}/health`)).status).toBe(401);
    const healthz = await fetch(`${url}/healthz`);
    expect(healthz.status).toBe(503);
    const missing = await fetch(`${url}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found", code: "NOT_FOUND" });
  });

  it("keeps the request bodies workers deployed before the contract send", async () => {
    const { url } = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const screenId = randomUUID();
    expect(await (await post("/lease/user/take", { screenId })).json()).toMatchObject({
      previous: null,
    });
    // `reason` and `clearCode` were optional, and still are.
    expect(await (await post("/lease/user/release", { screenId })).json()).toEqual({
      released: true,
    });
    const refused = await post("/lifecycle/ensure", { owner: "worker" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Lifecycle disabled", code: "CONFLICT" });
  });
});

describe("botd activity", () => {
  it("counts work on the computer as activity, but never a status read or lifecycle call", async () => {
    const lifecycle = new ComputeLifecycle(true, {
      start: async () => {},
      stop: async () => {},
      busy: async () => false,
    });
    let finish!: (result: PageCheckResult) => void;
    const check = vi.fn(
      () =>
        new Promise<PageCheckResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { botd } = await start({ lifecycle, pages: { check } });
    await botd.lifecycle.lease({ owner: "worker", demand: 0 });
    await botd.lifecycle.ensure({ owner: "worker" });
    const begin = vi.spyOn(lifecycle, "begin");
    await botd.health();
    await botd.healthz();
    await botd.lifecycle.capabilities();
    await botd.lifecycle.lease({ owner: "worker", demand: 0 });
    expect(begin).not.toHaveBeenCalled();

    const checking = botd.pages.check({ path: "/home/bot/shared/a.html" });
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    expect(begin).toHaveBeenCalledTimes(1);
    expect(lifecycle.hasWork).toBe(true);
    // The computer can't quiesce under the check.
    const busy = await rejection(botd.lifecycle.quiesce({ owner: "worker" }));
    expect(busy.status).toBe(409);
    finish(CHECKED);
    await checking;
    expect(lifecycle.hasWork).toBe(false);
    expect(await botd.lifecycle.quiesce({ owner: "worker" })).toMatchObject({ phase: "idle" });
  });

  it("does not count a call that fails as lasting activity", async () => {
    const lifecycle = new ComputeLifecycle(true, {
      start: async () => {},
      stop: async () => {},
      busy: async () => false,
    });
    const { botd } = await start({
      lifecycle,
      pages: { check: async () => Promise.reject(new Error("Chromium crashed")) },
    });
    await botd.lifecycle.lease({ owner: "worker", demand: 0 });
    await botd.lifecycle.ensure({ owner: "worker" });
    const error = await rejection(botd.pages.check({ path: "/home/bot/shared/a.html" }));
    expect(error.status).toBe(500);
    expect(error.detail).toBe("Chromium crashed");
    expect(lifecycle.hasWork).toBe(false);
    expect(await botd.lifecycle.quiesce({ owner: "worker" })).toMatchObject({ phase: "idle" });
  });
});
