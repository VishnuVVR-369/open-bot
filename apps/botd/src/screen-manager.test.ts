import type { EgressRouter } from "@open-bot/egress/router";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLease } from "./lease";
import type { PageChecker } from "./pages";
import { createRouter } from "./router";
import { ScreenManager } from "./screen-manager";
import { Screen, type ScreenDeps } from "./screens";

const deps = () =>
  ({
    supervisor: { state: () => "running" },
    cookies: {},
    desktopUser: { uid: 1001, gid: 1001, home: "/tmp/sleep-test-desktop", name: "desktop" },
    browserSandbox: false,
    socksPort: 1080,
    legacyProfile: "/tmp/unused",
    log: () => {},
  }) as unknown as ScreenDeps;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("screen resource admission", () => {
  it("counts starting screens atomically and queues a third without evicting leased screens", async () => {
    const gates: (() => void)[] = [];
    vi.spyOn(Screen.prototype, "start").mockImplementation(async function (this: Screen) {
      await new Promise<void>((resolve) => gates.push(resolve));
      this.state = "running";
    });
    vi.spyOn(Screen.prototype, "stop").mockImplementation(async function (this: Screen) {
      this.state = "stopping";
    });
    vi.spyOn(Screen.prototype, "forget").mockResolvedValue();
    const manager = new ScreenManager(deps(), { maxRunning: 2 });
    const a = manager.ensure("a"),
      b = manager.ensure("b");
    const abort = new AbortController();
    const c = manager.ensure("c", abort.signal);
    const cancelled = expect(c).rejects.toThrow("cancelled");
    expect(manager.list()).toHaveLength(2);
    expect(gates).toHaveLength(2);
    gates.splice(0).forEach((resolve) => resolve());
    const screens = await Promise.all([a, b]);
    screens.forEach((screen) => screen.lease.takeByUser());
    expect(manager.list()).toHaveLength(2);
    abort.abort(new Error("cancelled"));
    await cancelled;
    expect(manager.list()).toHaveLength(2);
    expect(Screen.prototype.stop).not.toHaveBeenCalled();
    await manager.stopAll();
  });

  it("bounds a queued request and shares starts without one cancellation cancelling another", async () => {
    vi.spyOn(Screen.prototype, "start").mockImplementation(async function (this: Screen) {
      this.state = "running";
    });
    vi.spyOn(Screen.prototype, "stop").mockResolvedValue();
    const manager = new ScreenManager(deps(), { maxRunning: 1, admissionMs: 20 });
    // Held, so it can't be stopped to make room.
    (await manager.ensure("a")).lease.takeByUser();
    const abort = new AbortController();
    const b = manager.ensure("b", abort.signal),
      shared = manager.ensure("b");
    const cancelled = expect(b).rejects.toThrow("cancelled");
    const timeout = expect(shared).rejects.toThrow("slots are busy");
    abort.abort(new Error("cancelled"));
    await cancelled;
    await timeout;
    expect(manager.list()).toHaveLength(1);
    await manager.stopAll();
  });

  it("makes room by stopping idle screens, unwatched and least recently used first, never a held one", async () => {
    let now = 0;
    vi.spyOn(Screen.prototype, "start").mockImplementation(async function (this: Screen) {
      this.state = "running";
    });
    const stopped: string[] = [];
    vi.spyOn(Screen.prototype, "stop").mockImplementation(async function (this: Screen) {
      this.state = "stopping";
      stopped.push(this.id);
    });
    // Idle screens free their slot right away, so a start never waits for one to idle out.
    const manager = new ScreenManager(deps(), { maxRunning: 4, admissionMs: 50, now: () => now });
    const held = await manager.ensure("held");
    now = 1;
    const watched = await manager.ensure("watched");
    now = 2;
    await manager.ensure("older");
    now = 3;
    await manager.ensure("newer");
    held.lease.takeByUser();
    watched.viewers = 1;

    now = 4;
    await manager.ensure("fifth");
    expect(stopped).toEqual(["older"]);
    expect(manager.get("held")).toBe(held);
    expect(manager.get("watched")).toBe(watched);
    expect(manager.get("older")).toBeUndefined();

    // Two at once each make their own room, and a screen holding a download is left alone.
    vi.spyOn(Screen.prototype, "busy", "get").mockImplementation(function (this: Screen) {
      return this.id === "fifth";
    });
    now = 5;
    await Promise.all([manager.ensure("sixth"), manager.ensure("seventh")]);
    expect(stopped).toEqual(["older", "newer", "watched"]);
    expect(
      manager
        .list()
        .map((screen) => screen.id)
        .sort(),
    ).toEqual(["fifth", "held", "seventh", "sixth"]);
    await manager.stopAll();
  });

  it("watching alone does not keep a screen alive, but a lease or download does", async () => {
    let now = 0;
    vi.spyOn(Screen.prototype, "start").mockImplementation(async function (this: Screen) {
      this.state = "running";
    });
    const stopped = vi.spyOn(Screen.prototype, "stop").mockResolvedValue();
    const manager = new ScreenManager(deps(), { maxRunning: 2, idleMs: 100, now: () => now });
    const passive = await manager.ensure("passive"),
      held = await manager.ensure("held");
    passive.viewers = 1;
    held.lease.takeByUser();
    now = 101;
    manager.sweep();
    await vi.waitFor(() => expect(manager.list()).toHaveLength(1));
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(manager.get("held")).toBe(held);
    await manager.stopAll();
  });
});

const A = "00000000-0000-4000-8000-00000000000a",
  B = "00000000-0000-4000-8000-00000000000b",
  C = "00000000-0000-4000-8000-00000000000c";

function startsRunning() {
  vi.spyOn(Screen.prototype, "start").mockImplementation(async function (this: Screen) {
    this.state = "running";
  });
}

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Real `Screen.stop()` against a stand-in supervisor and cookie jar, each flush held by the test. */
function teardownDeps() {
  const flushes: ReturnType<typeof deferred>[] = [];
  const supervisor = {
    state: () => "running",
    isRunning: vi.fn(() => false),
    stop: vi.fn(async (_name: string) => {}),
  };
  const cookies = {
    flush: vi.fn(() => {
      const flush = deferred();
      flushes.push(flush);
      return flush.promise;
    }),
    detach: vi.fn(),
  };
  return { deps: { ...deps(), supervisor, cookies } as unknown as ScreenDeps, supervisor, flushes };
}

describe("stopping a screen to make room", () => {
  it("never stops a screen a queued run is waiting to take", async () => {
    startsRunning();
    // Stops stay in progress until the test ends, the way a real one waits on the cookie flush.
    const stopped: string[] = [];
    const stopGate = deferred();
    vi.spyOn(Screen.prototype, "stop").mockImplementation(async function (this: Screen) {
      this.state = "stopping";
      stopped.push(this.id);
      await stopGate.promise;
    });
    vi.spyOn(Screen.prototype, "readPage").mockResolvedValue({
      url: "https://example.com/",
      title: "Example",
      text: "",
      truncated: false,
      links: [],
    });
    const acquiring = vi.spyOn(DesktopLease.prototype, "acquireForRun");
    const manager = new ScreenManager(deps(), { maxRunning: 2, admissionMs: 50 });
    const botd = createRouterClient(
      createRouter({
        screens: manager,
        egress: { noteDemand: () => {} } as unknown as EgressRouter,
        health: () => {
          throw new Error("unused");
        },
        pages: {} as PageChecker,
      }),
    );
    const ann = { botId: A, botName: "Ann" }; // The wire's field names. vocabulary: allow
    const first = { runId: "first", ...ann },
      second = { runId: "second", ...ann };
    const a = await manager.ensure(A);
    (await manager.ensure(B)).lease.takeByUser();
    expect(await a.lease.acquireForRun(first)).toBe("ok");

    // A second run of the same teammate queues for the lease the first one holds.
    const read = botd.computer.read({ run: second });
    await vi.waitFor(() => expect(acquiring).toHaveBeenCalledWith(second));
    // The first run finishes, and another teammate's screen needs a slot before the queued run retries.
    manager.releaseRun(first.runId);
    const third = expect(manager.ensure(C)).rejects.toThrow("slots are busy");
    try {
      expect(await read).toMatchObject({ ok: true, url: "https://example.com/" });
      expect(stopped).toEqual([]);
      expect(manager.get(A)).toBe(a);
      expect(a.lease.holder).toMatchObject({ runId: second.runId });
      await third;
    } finally {
      stopGate.resolve();
    }
    await manager.stopAll();
  });

  it("leaves a claimed screen to its claim in the idle sweep too", async () => {
    let now = 0;
    startsRunning();
    const stopped = vi.spyOn(Screen.prototype, "stop").mockResolvedValue();
    const manager = new ScreenManager(deps(), { maxRunning: 2, idleMs: 100, now: () => now });
    await manager.ensure(A);
    const release = deferred();
    const claimed = manager.claim(A, () => release.promise);
    now = 101;
    manager.sweep();
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await claimed;
    manager.sweep();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("keeps a screen whose stop failed before tearing anything down, and stops it on a later try", async () => {
    startsRunning();
    const { deps: screenDeps, supervisor, flushes } = teardownDeps();
    const manager = new ScreenManager(screenDeps, { maxRunning: 1, admissionMs: 50 });
    const a = await manager.ensure(A);
    const second = expect(manager.ensure(B)).rejects.toThrow("slots are busy");
    await vi.waitFor(() => expect(flushes).toHaveLength(1));
    // A run that asks for the screen while it stops gets it back once the stop fails.
    const again = manager.ensure(A);
    flushes[0]!.reject(new Error("disk full"));
    await second;
    expect(await again).toBe(a);
    expect(manager.get(A)).toBe(a);
    expect(supervisor.stop).not.toHaveBeenCalled();

    // Once the cookie jar saves again, the next start stops it and takes its slot.
    const third = manager.ensure(C);
    await vi.waitFor(() => expect(flushes).toHaveLength(2));
    flushes[1]!.resolve();
    await third;
    expect(manager.list().map((screen) => screen.id)).toEqual([C]);
    expect(supervisor.stop).toHaveBeenCalledTimes(5);
  });

  it("keeps the slot of a screen whose processes outlived its stop, and retries the stop on the next start", async () => {
    startsRunning();
    const { deps: screenDeps, supervisor, flushes } = teardownDeps();
    const manager = new ScreenManager(screenDeps, { maxRunning: 1, admissionMs: 50 });
    await manager.ensure(A);
    supervisor.stop.mockRejectedValueOnce(new Error("Process groups did not exit after SIGKILL"));
    const second = expect(manager.ensure(B)).rejects.toThrow("slots are busy");
    await vi.waitFor(() => expect(flushes).toHaveLength(1));
    flushes[0]!.resolve();
    await second;
    // Its browser may still be running, so its slot isn't handed to another screen.
    expect(manager.list().map((screen) => [screen.id, screen.state])).toEqual([[A, "stopping"]]);

    const third = manager.ensure(C);
    await vi.waitFor(() => expect(flushes).toHaveLength(2));
    flushes[1]!.resolve();
    await third;
    expect(manager.list().map((screen) => screen.id)).toEqual([C]);
  });

  it("stops a browser that doesn't exit after closing, instead of leaving its screen stopping", async () => {
    vi.useFakeTimers();
    startsRunning();
    const { deps: screenDeps, supervisor, flushes } = teardownDeps();
    // Chromium answers Browser.close but never exits.
    supervisor.isRunning.mockReturnValue(true);
    const manager = new ScreenManager(screenDeps, { maxRunning: 1 });
    const a = await manager.ensure(A);
    Object.assign(a, { cdp: { isOpen: true, send: vi.fn(async () => ({})) } });
    const second = manager.ensure(B);
    await vi.waitFor(() => expect(flushes).toHaveLength(1));
    flushes[0]!.resolve();
    await vi.advanceTimersByTimeAsync(11_000);
    await second;
    expect(supervisor.stop).toHaveBeenCalledWith(`${A.slice(0, 8)}/chromium`);
    expect(manager.list().map((screen) => screen.id)).toEqual([B]);
  });

  it("wakes a queued start as soon as a screen can be stopped: a lease handed back, a claim ended, a download done", async () => {
    // Fake timers: the admission deadline can't fire, so only a wake lets a queued start through.
    vi.useFakeTimers();
    startsRunning();
    const stopped: string[] = [];
    vi.spyOn(Screen.prototype, "stop").mockImplementation(async function (this: Screen) {
      this.state = "stopping";
      stopped.push(this.id);
    });
    const manager = new ScreenManager(deps(), { maxRunning: 1, admissionMs: 60_000 });
    /** Starts a screen and reports whether it has started yet. */
    const start = (id: string) => {
      const started = { done: false, screen: manager.ensure(id) };
      void started.screen.then(() => (started.done = true));
      return started;
    };
    // Runs everything already due, so a start that can go ahead does, and one that can't is queued.
    const settle = () => vi.advanceTimersByTimeAsync(1);

    const a = await manager.ensure(A);
    a.lease.takeByUser();
    const b = start(B);
    await settle();
    expect(b.done).toBe(false);
    a.lease.releaseByUser();
    await settle();
    expect(b.done).toBe(true);
    expect(stopped).toEqual([A]);

    const release = deferred();
    const claimed = manager.claim(B, () => release.promise);
    const c = start(C);
    await settle();
    expect(c.done).toBe(false);
    release.resolve();
    await claimed;
    await settle();
    expect(c.done).toBe(true);
    expect(stopped).toEqual([A, B]);

    const screenC = await c.screen;
    screenC.downloads.handle({ method: "Browser.downloadWillBegin", params: { guid: "report" } });
    const again = start(A);
    await settle();
    expect(again.done).toBe(false);
    screenC.downloads.handle({
      method: "Browser.downloadProgress",
      params: { guid: "report", state: "completed" },
    });
    await settle();
    expect(again.done).toBe(true);
    expect(stopped).toEqual([A, B, C]);
    await manager.stopAll();
  });
});
