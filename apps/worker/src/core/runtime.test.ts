import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "./runtime";

describe("Runtime", () => {
  const log = { warn: vi.fn() };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("stops what started in reverse, waiting for each", async () => {
    const runtime = new Runtime(log);
    const stopped: string[] = [];
    runtime.add("database", () => stopped.push("database"));
    await runtime.start("service", {
      start: () => stopped.push("started"),
      stop: async () => {
        await Promise.resolve();
        stopped.push("service");
      },
    });
    runtime.add("server", () => stopped.push("server"));
    await runtime.stop();
    expect(stopped).toEqual(["started", "server", "service", "database"]);
  });

  it("keeps stopping the rest when one part fails to", async () => {
    const runtime = new Runtime(log);
    const database = vi.fn();
    runtime.add("database", database);
    runtime.add("broken", () => Promise.reject(new Error("socket gone")));
    await runtime.stop();
    expect(database).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("broken didn't stop cleanly", { error: "socket gone" });
  });

  it("runs no timer task after shutdown", async () => {
    const runtime = new Runtime(log);
    const sweep = vi.fn();
    const first = vi.fn();
    runtime.every("sweep", 1_000, sweep);
    runtime.after("first", 5_000, first);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
  });

  it("stops once however often shutdown is asked for", async () => {
    const runtime = new Runtime(log);
    const stop = vi.fn();
    runtime.add("server", stop);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(stop).toHaveBeenCalledOnce();
    expect(() => runtime.add("late", stop)).toThrow(/after shutdown began/);
  });

  it("registers nothing for a service that failed to start", async () => {
    const runtime = new Runtime(log);
    const stop = vi.fn();
    await expect(
      runtime.start("broken", { start: () => Promise.reject(new Error("no")), stop }),
    ).rejects.toThrow("no");
    await runtime.stop();
    expect(stop).not.toHaveBeenCalled();
  });
});
