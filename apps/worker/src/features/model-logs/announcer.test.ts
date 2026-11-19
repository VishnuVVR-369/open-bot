import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLogAnnouncer } from "./announcer";
import type { ModelLogWriterEvents } from "./writer";

describe("model log announcer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces a save at once, then at most once per interval, never missing the last", async () => {
    const writer = new EventEmitter<ModelLogWriterEvents>();
    const announce = vi.fn(async () => {});
    const announcer = new ModelLogAnnouncer(writer, announce, 2_000);
    announcer.start();

    writer.emit("written", 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(announce).toHaveBeenCalledTimes(1);

    // Saves within the interval ride along with one announcement at its end.
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(500);
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(announce).toHaveBeenCalledTimes(2);

    // Nothing saved, nothing announced.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(announce).toHaveBeenCalledTimes(2);

    await announcer.stop();
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("sends the announcement still waiting for its interval when it stops, and waits for it", async () => {
    const writer = new EventEmitter<ModelLogWriterEvents>();
    let sent = 0;
    const announce = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      sent += 1;
    });
    const announcer = new ModelLogAnnouncer(writer, announce, 2_000);
    announcer.start();
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toBe(1);
    // Saved within the interval: waiting for its turn when shutdown comes.
    writer.emit("written", 1);
    const stopped = announcer.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(sent).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps announcing after an announcement fails", async () => {
    const writer = new EventEmitter<ModelLogWriterEvents>();
    const announce = vi.fn(async () => {
      throw new Error("the database is down");
    });
    const announcer = new ModelLogAnnouncer(writer, announce, 100);
    announcer.start();
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(0);
    writer.emit("written", 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(announce).toHaveBeenCalledTimes(2);
    await announcer.stop();
  });
});
