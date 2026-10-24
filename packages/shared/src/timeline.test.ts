import { describe, expect, it } from "vitest";
import { applyRunEvent, emptyTimeline, type RunEventPayload } from "./timeline";

const at = "2026-10-14T10:00:00.000Z";

describe("applyRunEvent", () => {
  it("builds a run's timeline from its events", () => {
    const events: RunEventPayload[] = [
      { type: "status", status: "running" },
      {
        type: "item",
        item: {
          id: "m",
          kind: "message",
          phase: "final",
          text: "",
          status: "running",
          startedAt: at,
        },
      },
      { type: "delta", itemId: "m", delta: "Hello" },
      { type: "delta", itemId: "m", delta: ", world" },
      {
        type: "item",
        item: {
          id: "c",
          kind: "command",
          command: "ls",
          cwd: "/",
          output: "",
          exitCode: null,
          durationMs: null,
          status: "running",
          startedAt: at,
        },
      },
      { type: "delta", itemId: "c", delta: "a.txt\n" },
      { type: "status", status: "waiting", waitingFor: "approval" },
    ];
    const state = events.reduce(applyRunEvent, emptyTimeline());
    expect(state.status).toBe("waiting");
    expect(state.waitingFor).toBe("approval");
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ text: "Hello, world" });
    expect(state.items[1]).toMatchObject({ output: "a.txt\n" });
  });

  it("replaces an item when it completes and ignores deltas for unknown items", () => {
    let state = applyRunEvent(emptyTimeline(), {
      type: "item",
      item: {
        id: "m",
        kind: "message",
        phase: "commentary",
        text: "Hel",
        status: "running",
        startedAt: at,
      },
    });
    state = applyRunEvent(state, { type: "delta", itemId: "missing", delta: "x" });
    state = applyRunEvent(state, {
      type: "item",
      item: {
        id: "m",
        kind: "message",
        phase: "commentary",
        text: "Hello",
        status: "completed",
        startedAt: at,
      },
    });
    expect(state.items).toEqual([expect.objectContaining({ text: "Hello", status: "completed" })]);
    state = applyRunEvent(state, { type: "status", status: "completed" });
    expect(state.waitingFor).toBeUndefined();
  });
});
