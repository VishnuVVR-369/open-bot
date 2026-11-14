import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.restoreAllMocks());

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
