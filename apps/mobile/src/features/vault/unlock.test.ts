import { describe, expect, it } from "vitest";
import { createVaultLock, VAULT_OPEN_MS, type VaultLockDeps } from "./unlock";

function setup(overrides: Partial<VaultLockDeps> = {}) {
  let now = 1_000;
  const timers: { run: () => void; at: number; cleared: boolean }[] = [];
  let checks = 0;
  let answer = true;
  const lock = createVaultLock({
    now: () => now,
    canCheck: async () => true,
    check: async () => {
      checks += 1;
      return answer;
    },
    setTimer: (run, ms) => {
      const timer = { run, at: now + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    ...overrides,
  });
  return {
    lock,
    checks: () => checks,
    answer: (value: boolean) => (answer = value),
    advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true;
          timer.run();
        }
    },
  };
}

describe("the vault's lock", () => {
  it("opens only with your fingerprint, and stays open for five minutes", async () => {
    const t = setup();
    expect(t.lock.isOpen()).toBe(false);
    expect(await t.lock.unlock()).toEqual({ ok: true });
    expect(t.lock.isOpen()).toBe(true);
    // Open already: no second prompt.
    expect(await t.lock.unlock()).toEqual({ ok: true });
    expect(t.checks()).toBe(1);
    t.advance(VAULT_OPEN_MS - 1);
    expect(t.lock.isOpen()).toBe(true);
    t.advance(1);
    expect(t.lock.isOpen()).toBe(false);
    expect(t.lock.getState()).toMatchObject({ openedAt: null, locks: 1 });
  });

  it("stays locked when you cancel, and says so", async () => {
    const t = setup();
    t.answer(false);
    expect(await t.lock.unlock()).toEqual({ ok: false, reason: "cancelled" });
    expect(t.lock.isOpen()).toBe(false);
    expect(t.lock.getState().prompting).toBe(false);
  });

  it("can't open on a phone without a screen lock", async () => {
    const t = setup({ canCheck: async () => false });
    expect(await t.lock.unlock()).toEqual({ ok: false, reason: "no-screen-lock" });
    expect(t.checks()).toBe(0);
  });

  it("asks once when two screens ask at the same time", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.lock.unlock(), t.lock.unlock()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(t.checks()).toBe(1);
  });

  it("locks when the app leaves the screen, but not for the PIN screen the prompt opens", async () => {
    const t = setup();
    let release: (value: boolean) => void = () => {};
    const slow = setup({ check: () => new Promise<boolean>((resolve) => (release = resolve)) });
    const opening = slow.lock.unlock();
    await Promise.resolve();
    slow.lock.backgrounded();
    release(true);
    expect(await opening).toEqual({ ok: true });
    expect(slow.lock.isOpen()).toBe(true);

    await t.lock.unlock();
    t.lock.backgrounded();
    expect(t.lock.isOpen()).toBe(false);
    expect(t.lock.getState().locks).toBe(1);
    // Locked already: no new lock to tell screens about.
    t.lock.backgrounded();
    expect(t.lock.getState().locks).toBe(1);
  });

  it("tells listeners when it opens and locks", async () => {
    const t = setup();
    const seen: (number | null)[] = [];
    const stop = t.lock.subscribe(() => seen.push(t.lock.getState().openedAt));
    await t.lock.unlock();
    t.lock.lock();
    stop();
    await t.lock.unlock();
    expect(seen).toEqual([null, 1_000, 1_000, null]);
  });
});
