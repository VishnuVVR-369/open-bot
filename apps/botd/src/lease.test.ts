import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenLease, type LeaseChange } from "./lease";

const nova = { runId: "run-1", teammateId: "teammate-1", teammateName: "Nova" };
const atlas = { runId: "run-2", teammateId: "teammate-2", teammateName: "Atlas" };

describe("ScreenLease", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-13T10:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("does not disconnect a code lease without a viewer; idle release uses its safety guard", async () => {
    const guard = vi.fn(async () => false);
    const lease = new ScreenLease({ userIdleMs: 600_000, userDisconnectMs: 90_000 });
    lease.protectCode(guard);
    vi.advanceTimersByTime(91_000);
    lease.sweep();
    expect(guard).not.toHaveBeenCalled();
    expect(lease.holder?.kind).toBe("user-code");
    vi.advanceTimersByTime(510_000);
    lease.sweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(guard).toHaveBeenCalledWith(true, "user_idle");
    expect(lease.holder).toMatchObject({ pausedForSafety: true });
  });

  it("gives a free screen to the first run and keeps it for that run", async () => {
    const lease = new ScreenLease();
    expect(await lease.acquireForRun(nova)).toBe("ok");
    expect(await lease.acquireForRun(nova)).toBe("ok");
    expect(lease.holder).toMatchObject({ kind: "run", runId: "run-1" });
  });

  it("makes another run wait, then reports the screen as busy", async () => {
    const lease = new ScreenLease({ waitMs: 30_000 });
    await lease.acquireForRun(nova);
    const waiting = lease.acquireForRun(atlas);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await waiting).toBe("desktop_busy");
  });

  it("hands the screen to a waiting run once the holder releases it", async () => {
    const lease = new ScreenLease();
    await lease.acquireForRun(nova);
    const waiting = lease.acquireForRun(atlas);
    await vi.advanceTimersByTimeAsync(1_000);
    lease.releaseRun("run-1");
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toBe("ok");
    expect(lease.holder).toMatchObject({ kind: "run", runId: "run-2" });
  });

  it("lets you take over immediately and blocks every run", async () => {
    const lease = new ScreenLease();
    const preempted = vi.fn();
    lease.on("preempted", preempted);
    await lease.acquireForRun(nova);
    lease.takeByUser();
    expect(preempted).toHaveBeenCalledWith(nova);
    expect(lease.holder?.kind).toBe("user");
    expect(await lease.acquireForRun(nova)).toBe("user_has_control");
    expect(await lease.acquireForRun(atlas)).toBe("user_has_control");
  });

  it("returns control after you hand back", async () => {
    const lease = new ScreenLease();
    const changes: LeaseChange[] = [];
    lease.on("change", (change) => changes.push(change));
    lease.takeByUser();
    lease.userConnected("c1");
    expect(lease.releaseByUser("handed_back")).toBe(true);
    expect(lease.holder).toBeNull();
    expect(changes.map((change) => change.reason)).toEqual(["acquired", "handed_back"]);
    expect(await lease.acquireForRun(nova)).toBe("ok");
  });

  it("releases idle runs and idle or disconnected users", async () => {
    const lease = new ScreenLease({
      runIdleMs: 120_000,
      userIdleMs: 600_000,
      userDisconnectMs: 90_000,
    });
    await lease.acquireForRun(nova);
    vi.advanceTimersByTime(121_000);
    lease.sweep();
    expect(lease.holder).toBeNull();

    lease.takeByUser();
    lease.userConnected("c1");
    vi.advanceTimersByTime(300_000);
    lease.touchUser();
    vi.advanceTimersByTime(300_000);
    lease.sweep();
    expect(lease.holder?.kind).toBe("user");
    vi.advanceTimersByTime(301_000);
    lease.sweep();
    expect(lease.holder).toBeNull();

    lease.takeByUser();
    lease.userConnected("c2");
    // A late close from the previous takeover's connection must not count.
    lease.userDisconnected("c1");
    vi.advanceTimersByTime(91_000);
    lease.sweep();
    expect(lease.holder?.kind).toBe("user");
    lease.userDisconnected("c2");
    vi.advanceTimersByTime(91_000);
    lease.sweep();
    expect(lease.holder).toBeNull();
  });

  it("lets a run take the screen from a run that went idle", async () => {
    const lease = new ScreenLease({ runIdleMs: 120_000 });
    await lease.acquireForRun(nova);
    vi.advanceTimersByTime(125_000);
    expect(await lease.acquireForRun(atlas)).toBe("ok");
    expect(lease.holder).toMatchObject({ runId: "run-2" });
  });
});
