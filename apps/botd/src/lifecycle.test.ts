import { describe, expect, it, vi } from "vitest";
import { ComputeLifecycle, ComputerBusy } from "./lifecycle";
function setup() {
  let now = 0;
  const deps = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    busy: vi.fn(async () => false),
    now: () => now,
  };
  const lifecycle = new ComputeLifecycle(true, deps);
  lifecycle.lease("worker", 0);
  return {
    lifecycle,
    deps,
    advance: () => {
      now += 46_000;
    },
  };
}
describe("botd compute lifecycle", () => {
  it("starts lazily and makes repeated ensure/quiesce idempotent", async () => {
    const { lifecycle, deps } = setup();
    expect(lifecycle.status.phase).toBe("idle");
    await Promise.all([lifecycle.ensure("worker"), lifecycle.ensure("worker")]);
    expect(deps.start).toHaveBeenCalledTimes(1);
    await lifecycle.quiesce("worker");
    await lifecycle.quiesce("worker");
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });
  it("rejects a second controller and never stops on socket loss or expired leases", async () => {
    const { lifecycle, deps, advance } = setup();
    await lifecycle.ensure("worker");
    expect(() => lifecycle.lease("other", 0)).toThrow("Another worker");
    advance();
    await expect(lifecycle.quiesce("worker")).rejects.toThrow("lease");
    expect(deps.stop).not.toHaveBeenCalled();
    lifecycle.lease("other", 0);
  });
  it("refuses active HTTP work, downloads, lease holders and controller demand", async () => {
    const { lifecycle, deps } = setup();
    await lifecycle.ensure("worker");
    const end = lifecycle.begin();
    await expect(lifecycle.quiesce("worker")).rejects.toThrow("active");
    end();
    end();
    deps.busy.mockResolvedValueOnce(true);
    await expect(lifecycle.quiesce("worker")).rejects.toBeInstanceOf(ComputerBusy);
    lifecycle.lease("worker", 1);
    await expect(lifecycle.quiesce("worker")).rejects.toThrow("active");
    expect(deps.stop).not.toHaveBeenCalled();
  });
  it("fences new work while stopping and propagates child shutdown failures", async () => {
    const { lifecycle, deps } = setup();
    await lifecycle.ensure("worker");
    deps.stop.mockRejectedValueOnce(new Error("child alive"));
    const quiesce = lifecycle.quiesce("worker");
    expect(() => lifecycle.begin()).toThrow("stopping");
    await expect(quiesce).rejects.toThrow("child alive");
    await expect(quiesce).rejects.not.toBeInstanceOf(ComputerBusy);
    expect(lifecycle.status.phase).toBe("awake");
  });
  it("live turns and unknown RPC outcomes survive disconnect and block stopping", async () => {
    const { lifecycle } = setup();
    await lifecycle.ensure("worker");
    lifecycle.rpc("socket", true, JSON.stringify({ id: 1, method: "turn/start" }));
    await expect(lifecycle.quiesce("worker")).rejects.toThrow("active");
    lifecycle.rpc("socket", false, JSON.stringify({ id: 1, result: {} }));
    lifecycle.rpc(
      "socket",
      false,
      JSON.stringify({ method: "turn/started", params: { turn: { id: "t" } } }),
    );
    await expect(lifecycle.quiesce("worker")).rejects.toThrow("active");
    lifecycle.rpc(
      "socket",
      false,
      JSON.stringify({ method: "turn/completed", params: { turn: { id: "t" } } }),
    );
    await lifecycle.quiesce("worker");
  });
});

it("ensures readiness again after the supervised agent restarts", async () => {
  let ready = false;
  const start = vi.fn(async () => {
    ready = true;
  });
  const lifecycle = new ComputeLifecycle(true, {
    start,
    ready: () => ready,
    stop: async () => {},
    busy: async () => false,
  });
  lifecycle.lease("worker", 0);
  await lifecycle.ensure("worker");
  ready = false;
  await lifecycle.ensure("worker");
  expect(start).toHaveBeenCalledTimes(2);
});
