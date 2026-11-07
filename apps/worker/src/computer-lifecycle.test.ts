import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerLifecycle, type LifecycleHooks } from "./computer-lifecycle";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(overrides: Partial<LifecycleHooks> = {}) {
  const hooks: LifecycleHooks = {
    wake: vi.fn(async () => true),
    restore: vi.fn(async () => {}),
    quiesce: vi.fn(async () => true),
    pause: vi.fn(),
    renew: vi.fn(async () => {}),
    busy: () => false,
    changed: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
  const lifecycle = new ComputerLifecycle(true, hooks, 100, 1_000);
  return { lifecycle, hooks };
}
afterEach(() => vi.useRealTimers());

describe("computer lifecycle admission", () => {
  it("shares one wake, holds demand through work, and releases once on errors", async () => {
    const wake = deferred(),
      work = deferred();
    const { lifecycle, hooks } = setup({
      wake: vi.fn(async () => {
        await wake.promise;
        return true;
      }),
    });
    const first = lifecycle.run("run", () => work.promise);
    const second = lifecycle.run("file", async () => {
      throw new Error("file failed");
    });
    const rejected = expect(second).rejects.toThrow("file failed");
    expect(lifecycle.status.demand).toEqual(["run", "file"]);
    expect(hooks.wake).toHaveBeenCalledTimes(1);
    wake.resolve();
    await rejected;
    expect(lifecycle.status.demand).toEqual(["run"]);
    await lifecycle.idle();
    expect(hooks.quiesce).not.toHaveBeenCalled();
    work.resolve();
    await first;
    expect(lifecycle.status.phase).toBe("grace");
    await lifecycle.idle();
    expect(lifecycle.status.phase).toBe("idle");
    lifecycle.stop();
  });

  it("cancelling one caller leaves a shared wake running for the others", async () => {
    const wake = deferred();
    const { lifecycle, hooks } = setup({
      wake: async () => {
        await wake.promise;
        return true;
      },
    });
    const abort = new AbortController();
    const cancelled = lifecycle.run(
      "cancel",
      async () => {
        throw new Error("must not run");
      },
      abort.signal,
    );
    const rejected = expect(cancelled).rejects.toThrow("cancelled");
    const active = lifecycle.run("keep", async () => "done");
    abort.abort(new Error("cancelled"));
    await rejected;
    wake.resolve();
    expect(await active).toBe("done");
    expect(hooks.restore).toHaveBeenCalledTimes(1);
    expect(lifecycle.status.demand).toEqual([]);
    lifecycle.stop();
  });

  it("new demand during quiesce waits for stop and wakes again before executing", async () => {
    const stopping = deferred(),
      order: string[] = [];
    const { lifecycle, hooks } = setup({
      quiesce: async () => {
        order.push("stop");
        await stopping.promise;
        order.push("stopped");
        return true;
      },
    });
    await lifecycle.run("first", async () => {});
    const idle = lifecycle.idle();
    const next = lifecycle.run("next", async () => {
      order.push("work");
    });
    expect(order).toEqual(["stop"]);
    stopping.resolve();
    await Promise.all([idle, next]);
    expect(order).toEqual(["stop", "stopped", "work"]);
    expect(hooks.wake).toHaveBeenCalledTimes(2);
    lifecycle.stop();
  });

  it("a computer that stays awake for running work is not an error, and sleeps once it's done", async () => {
    const { lifecycle, hooks } = setup({
      quiesce: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });
    await lifecycle.run("first", async () => {});
    await lifecycle.idle();
    expect(hooks.pause).not.toHaveBeenCalled();
    expect(hooks.warn).not.toHaveBeenCalled();
    expect(lifecycle.status).toMatchObject({ phase: "grace", error: null });
    await lifecycle.idle();
    expect(hooks.quiesce).toHaveBeenCalledTimes(2);
    expect(lifecycle.status).toMatchObject({ phase: "idle", error: null });
    lifecycle.stop();
  });

  it("failed quiesce and lease renewal keep the computer usable without showing an error", async () => {
    vi.useFakeTimers();
    const { lifecycle, hooks } = setup({
      quiesce: vi.fn(async () => {
        throw new Error("botd /lifecycle/quiesce returned 500");
      }),
      renew: vi.fn(async () => {
        throw new Error("botd /lifecycle/lease returned 502");
      }),
    });
    await lifecycle.run("first", async () => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hooks.renew).toHaveBeenCalled();
    expect(hooks.pause).not.toHaveBeenCalled();
    expect(hooks.warn).toHaveBeenCalledWith("computer lease renewal failed", expect.any(Error));
    expect(hooks.warn).toHaveBeenCalledWith("computer did not go idle", expect.any(Error));
    expect(lifecycle.status).toMatchObject({ phase: "grace", error: null });
    lifecycle.stop();
  });

  it("failed wake releases demand, tells the user in plain words, and can retry", async () => {
    const retry = setup({
      wake: vi.fn().mockRejectedValueOnce(new Error("502")).mockResolvedValue(true),
    });
    await expect(retry.lifecycle.run("failed", async () => {})).rejects.toThrow(
      "Computer wake failed: Error: 502",
    );
    expect(retry.lifecycle.status).toMatchObject({
      phase: "idle",
      demand: [],
      error: "The computer didn't wake up. Your next task or Wake screen will try again.",
    });
    await retry.lifecycle.run("retry", async () => {});
    expect(retry.lifecycle.status.phase).toBe("grace");
    retry.lifecycle.stop();
  });

  it("idle timers do not poll the computer and new demand cancels grace", async () => {
    vi.useFakeTimers();
    const { lifecycle, hooks } = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hooks.wake).not.toHaveBeenCalled();
    await lifecycle.run("file", async () => {});
    await vi.advanceTimersByTimeAsync(90);
    const release = await lifecycle.hold("run");
    await vi.advanceTimersByTimeAsync(200);
    expect(hooks.quiesce).not.toHaveBeenCalled();
    release();
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(hooks.quiesce).toHaveBeenCalledTimes(1);
    lifecycle.stop();
  });

  it("mixed versions stay awake and a disabled lifecycle preserves eager behavior", async () => {
    const { lifecycle, hooks } = setup({ wake: async () => false });
    await lifecycle.run("file", async () => {});
    await lifecycle.idle();
    expect(hooks.quiesce).not.toHaveBeenCalled();
    lifecycle.stop();
    const eager = new ComputerLifecycle(false, hooks);
    await eager.run("file", async () => {});
    expect(hooks.restore).toHaveBeenCalledTimes(1);
    eager.stop();
  });

  it("does not inherit a finished wake scope in later event callbacks", async () => {
    const event = deferred();
    let callback!: Promise<void>;
    const { lifecycle } = setup({
      restore: async () => {
        callback = event.promise.then(async () => {
          expect(lifecycle.inScope).toBe(false);
          const release = await lifecycle.hold("event");
          expect(lifecycle.status.demand).toContain("event");
          release();
        });
      },
    });
    await lifecycle.run("first", async () => {});
    event.resolve();
    await callback;
    lifecycle.stop();
  });
});

it("bounds the complete wake and releases demand if restore never answers", async () => {
  const hooks: LifecycleHooks = {
    wake: async () => true,
    restore: () => new Promise(() => {}),
    quiesce: async () => true,
    pause: vi.fn(),
    renew: async () => {},
    busy: () => false,
    changed: vi.fn(),
    warn: vi.fn(),
  };
  const lifecycle = new ComputerLifecycle(true, hooks, 100, 25);
  await expect(lifecycle.run("file", async () => {})).rejects.toThrow("Computer wake failed");
  expect(lifecycle.status.demand).toEqual([]);
  expect(hooks.pause).toHaveBeenCalledTimes(1);
  lifecycle.stop();
});

it("re-ensures a restarted botd on the next demand without idle reconnect polling", async () => {
  const { lifecycle, hooks } = setup();
  await lifecycle.run("first", async () => {});
  lifecycle.connectionLost();
  expect(lifecycle.status.phase).toBe("idle");
  expect(hooks.pause).toHaveBeenCalledTimes(1);
  expect(hooks.wake).toHaveBeenCalledTimes(1);
  await lifecycle.run("next", async () => {});
  expect(hooks.wake).toHaveBeenCalledTimes(2);
  lifecycle.stop();
});
