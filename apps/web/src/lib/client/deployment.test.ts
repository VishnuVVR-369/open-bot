import { describe, expect, it } from "vitest";
import { isOutdated } from "../deployment";
import { createReloader, planReload, type ReloaderEnvironment } from "./deployment";

/** How the tab's session storage behaves: fine, missing, or failing reads or writes. */
type StorageMode = "ok" | "none" | "read-fails" | "write-fails";

/** One browser tab: its session storage survives reloads, everything else is per page load. */
function tab(storage = new Map<string, string>(), mode: StorageMode = "ok") {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const listeners = new Set<() => void>();
  const notices: ({ reloadsWhenHidden: boolean } | null)[] = [];
  let reloadFromNotice = () => {};
  const state = { hidden: false, editing: false, reloads: 0 };
  const environment: ReloaderEnvironment = {
    storage:
      mode === "none"
        ? null
        : {
            getItem: (key) => {
              if (mode === "read-fails") throw new Error("SecurityError");
              return storage.get(key) ?? null;
            },
            setItem: (key, value) => {
              if (mode === "write-fails") throw new Error("QuotaExceededError");
              storage.set(key, value);
            },
            removeItem: (key) => void storage.delete(key),
          },
    document: {
      get hidden() {
        return state.hidden;
      },
      addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    } as ReloaderEnvironment["document"],
    editing: () => state.editing,
    reload: () => void state.reloads++,
    now: () => now,
    setTimeout: (callback, ms) => {
      timers.set(nextTimer, { at: now + ms, callback });
      return nextTimer++;
    },
    clearTimeout: (timer) => void timers.delete(timer as number),
    notify: (notice) => {
      if (notice) reloadFromNotice = notice.onReload;
      notices.push(notice && { reloadsWhenHidden: notice.reloadsWhenHidden });
    },
  };
  return {
    storage,
    state,
    listeners,
    notices,
    timers,
    /** Presses Reload on the notice. */
    pressReload: () => reloadFromNotice(),
    /** A page load of this tab, with fresh code-level state. */
    load: () => createReloader(environment),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
    hide() {
      state.hidden = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("noticing a new deploy", () => {
  it("is outdated only when the server names a different deploy", () => {
    expect(isOutdated("b2", "a1")).toBe(true);
    expect(isOutdated("b2", null)).toBe(true);
    expect(isOutdated("a1", "a1")).toBe(false);
    // A server that names none (dev, or a build without a commit) never sends tabs reloading.
    expect(isOutdated(null, "a1")).toBe(false);
    expect(isOutdated("", "a1")).toBe(false);
    expect(isOutdated(undefined, "a1")).toBe(false);
  });

  it("reloads at once unless you're typing", () => {
    const fresh = { attempts: null, now: 0 };
    expect(planReload({ hidden: false, editing: false, ...fresh })).toEqual({ kind: "now" });
    expect(planReload({ hidden: true, editing: true, ...fresh })).toEqual({ kind: "now" });
    expect(planReload({ hidden: false, editing: true, ...fresh })).toEqual({ kind: "when-hidden" });
  });
});

describe("reloading onto a new deploy", () => {
  it("tries again, later, when a reload brings back the old code", () => {
    const browser = tab();
    browser.load().outdated("b");
    expect(browser.state.reloads).toBe(1);

    // The reload reached the old server during the switch-over; the next stream reaches the new.
    browser.load().outdated("b");
    expect(browser.state.reloads).toBe(1);
    browser.advance(4_999);
    expect(browser.state.reloads).toBe(1);
    browser.advance(1);
    expect(browser.state.reloads).toBe(2);

    browser.load().outdated("b");
    browser.advance(30_000);
    expect(browser.state.reloads).toBe(3);
  });

  it("stops after three tries and leaves the reload to you", () => {
    const browser = tab();
    for (let i = 0; i < 3; i++) {
      browser.load().outdated("b");
      browser.advance(60_000);
    }
    expect(browser.state.reloads).toBe(3);
    browser.load().outdated("b");
    browser.advance(60_000);
    expect(browser.state.reloads).toBe(3);
    expect(browser.notices.at(-1)).toEqual({ reloadsWhenHidden: false });
  });

  it("starts over once the tab runs the deploy the server names", () => {
    const browser = tab();
    for (let i = 0; i < 3; i++) {
      browser.load().outdated("b");
      browser.advance(60_000);
    }
    browser.load().current();
    expect(browser.storage.size).toBe(0);
    browser.load().outdated("c");
    expect(browser.state.reloads).toBe(4);
  });

  it("waits for you to switch away while you type, with one reload however often it hears", () => {
    const browser = tab();
    const reloader = browser.load();
    browser.state.editing = true;
    // Reconnects and chat switches each bring a new `ready` from the new deploy.
    reloader.outdated("b");
    reloader.outdated("b");
    reloader.outdated("c");
    expect(browser.state.reloads).toBe(0);
    expect(browser.listeners.size).toBe(1);
    expect(browser.notices.at(-1)).toEqual({ reloadsWhenHidden: true });
    browser.hide();
    expect(browser.state.reloads).toBe(1);
    expect(browser.listeners.size).toBe(0);
    expect(JSON.parse(browser.storage.get("openbot:deployment-reloads")!)).toMatchObject({
      deployment: "c",
      count: 1,
    });
  });

  it("drops a waiting reload once the server runs this tab's deploy again", () => {
    const browser = tab();
    const reloader = browser.load();
    browser.state.editing = true;
    reloader.outdated("b");
    reloader.current();
    expect(browser.listeners.size).toBe(0);
    expect(browser.notices.at(-1)).toBeNull();
    browser.hide();
    expect(browser.state.reloads).toBe(0);
  });

  it.each(["none", "read-fails", "write-fails"] as const)(
    "leaves the reload to you when storage is %s, since nothing would stop a loop",
    (mode) => {
      const browser = tab(new Map(), mode);
      for (let i = 0; i < 6; i++) {
        browser.load().outdated("b");
        browser.advance(60_000);
      }
      expect(browser.state.reloads).toBe(0);
      expect(browser.notices.at(-1)).toEqual({ reloadsWhenHidden: false });
      browser.pressReload();
      expect(browser.state.reloads).toBe(1);
    },
  );
});
