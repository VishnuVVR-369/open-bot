import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./screens";

/** The arguments a POSIX shell gets back from `quoted`, the way /etc/chromium.d/open-bot reads them. */
function shellArgs(quoted: string): string[] {
  const output = execFileSync("sh", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "sh", quoted], {
    cwd: "/",
  }).toString();
  return output.split("\0").slice(0, -1);
}

describe("shellQuote", () => {
  it("keeps every argument whole through a shell, without splitting or globbing", () => {
    const args = [
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--user-data-dir=/home/desktop/screens/a b/chromium",
      "--no-sandbox",
      'it\'s $HOME `id` "quoted"',
      "",
    ];
    expect(shellArgs(shellQuote(args))).toEqual(args);
  });
});

import { afterEach, vi } from "vitest";
import { Screen, ScreenManager, type ScreenDeps } from "./screens";
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
    await manager.ensure("a");
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
