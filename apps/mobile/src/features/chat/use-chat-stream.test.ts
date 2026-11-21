// useChat's live stream: watching only while focused, and resuming from the right event after
// older history loads, without missing or repeating any.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The helper mocks the router, API and realtime modules when it loads, so import it before the
// hook or anything it mocks: an import of "./use-chat" above this one loads the real modules.
import {
  client,
  hook,
  page,
  refresh,
  render,
  resetChat,
  state,
  unmountChat,
} from "./use-chat.testing";

beforeEach(resetChat);
afterEach(unmountChat);

describe("chat stream focus", () => {
  it("only watches while focused, and refreshes behind another screen cannot subscribe", async () => {
    state.focused = false;
    await render();
    expect(state.watch).not.toHaveBeenCalled();
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenCalledWith("a", 60, expect.any(Function));
    state.focused = false;
    await render();
    expect(state.watch.mock.results[0]!.value).toHaveBeenCalledOnce();
    await refresh(page(32, 61));
    expect(state.watch).toHaveBeenCalledTimes(1);
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenLastCalledWith("a", 60, expect.any(Function));
  });
});

describe("retained run watermarks", () => {
  it("replays older-run events after a newer latest snapshot omits that run", async () => {
    const older = { ...page(1, 30, false), cursor: 60 };
    state.get.mockResolvedValue(older);
    await render();
    await act(async () => {
      await hook.loadOlder();
    });
    await refresh({ ...page(32, 61), cursor: 70 });
    state.focused = false;
    await render();
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenLastCalledWith("a", 60, expect.any(Function));
    await act(async () => {
      state.watch.mock.calls.at(-1)![2]({
        id: 65,
        runId: "r1",
        payload: { type: "status", status: "running" },
      });
    });
    expect(hook.runs.r1!.timeline.status).toBe("running");
  });

  it("does not double-apply a delta already included in an older-page snapshot", async () => {
    const older = { ...page(1, 30, false), cursor: 70 };
    const row = older.entries[0]!;
    if (row.type !== "run") throw new Error("expected a run");
    row.run.timeline = {
      status: "running",
      items: [
        {
          id: "m",
          kind: "message",
          phase: "final",
          text: "Hello",
          status: "running",
          startedAt: row.at,
        },
      ],
    };
    state.get.mockResolvedValue(older);
    await render();
    await act(async () => {
      await hook.loadOlder();
    });
    await act(async () => {
      const listener = state.watch.mock.calls.at(-1)![2];
      listener({ id: 65, runId: "r1", payload: { type: "delta", itemId: "m", delta: "lo" } });
      listener({ id: 71, runId: "r1", payload: { type: "delta", itemId: "m", delta: "!" } });
    });
    expect(hook.runs.r1!.timeline.items[0]).toMatchObject({ text: "Hello!" });
  });
});

describe("processed stream checkpoints", () => {
  it("resumes at the processed checkpoint without reconnecting for every event", async () => {
    await render();
    await refresh({ ...page(32, 61), cursor: 70 });
    const watches = state.watch.mock.calls.length;
    await act(async () => {
      const listener = state.watch.mock.calls.at(-1)![2];
      listener({ id: 65, runId: "r31", payload: { type: "status", status: "running" } });
      listener({ id: 71, runId: "r60", payload: { type: "status", status: "running" } });
    });
    expect(hook.runs.r31!.timeline.status).toBe("running");
    expect(state.watch).toHaveBeenCalledTimes(watches);
    state.focused = false;
    await render();
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenLastCalledWith("a", 71, expect.any(Function));
    await refresh({ ...page(33, 62), cursor: 75 });
    state.focused = false;
    await render();
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenLastCalledWith("a", 71, expect.any(Function));
  });

  it("rewinds for older history outside the buffer and applies replayed deltas once in order", async () => {
    await render();
    await act(async () => {
      state.watch.mock.calls.at(-1)![2]({
        id: 80,
        runId: "r31",
        payload: { type: "status", status: "running" },
      });
    });
    const older = { ...page(1, 30, false), cursor: 30 };
    const row = older.entries[0]!;
    if (row.type !== "run") throw new Error("expected run");
    row.run.timeline = {
      status: "running",
      items: [
        {
          id: "m",
          kind: "message",
          phase: "final",
          text: "A",
          status: "running",
          startedAt: row.at,
        },
      ],
    };
    state.get.mockResolvedValueOnce(older);
    await act(async () => {
      await hook.loadOlder();
    });
    expect(state.watch).toHaveBeenLastCalledWith("a", 30, expect.any(Function));
    await act(async () => {
      const listener = state.watch.mock.calls.at(-1)![2];
      listener({ id: 40, runId: "r1", payload: { type: "delta", itemId: "m", delta: "B" } });
      listener({ id: 85, runId: "r1", payload: { type: "delta", itemId: "m", delta: "C" } });
    });
    expect(hook.runs.r1!.timeline.items[0]).toMatchObject({ text: "ABC" });
    await refresh({ ...page(32, 61), cursor: 90 });
    expect(hook.runs.r1!.timeline.items[0]).toMatchObject({ text: "ABC" });
    state.focused = false;
    await render();
    state.focused = true;
    await render();
    expect(state.watch).toHaveBeenLastCalledWith("a", 85, expect.any(Function));
  });
});

describe("buffer coverage", () => {
  it("does not skip missing deltas when an older snapshot predates the replay buffer", async () => {
    await render();
    await act(async () => {
      state.watch.mock.calls.at(-1)![2]({
        id: 80,
        runId: "r1",
        payload: { type: "delta", itemId: "m", delta: "C" },
      });
    });
    const older = { ...page(1, 30, false), cursor: 30 };
    const row = older.entries[0]!;
    if (row.type !== "run") throw new Error("expected run");
    row.run.timeline = {
      status: "running",
      items: [
        {
          id: "m",
          kind: "message",
          phase: "final",
          text: "A",
          status: "running",
          startedAt: row.at,
        },
      ],
    };
    state.get.mockResolvedValueOnce(older);
    await act(async () => {
      await hook.loadOlder();
    });
    expect(hook.runs.r1!.timeline.items[0]).toMatchObject({ text: "A" });
    expect(state.watch).toHaveBeenLastCalledWith("a", 30, expect.any(Function));
    await act(async () => {
      const listener = state.watch.mock.calls.at(-1)![2];
      listener({ id: 40, runId: "r1", payload: { type: "delta", itemId: "m", delta: "B" } });
      listener({ id: 80, runId: "r1", payload: { type: "delta", itemId: "m", delta: "C" } });
      listener({ id: 80, runId: "r1", payload: { type: "delta", itemId: "m", delta: "C" } });
    });
    expect(hook.runs.r1!.timeline.items[0]).toMatchObject({ text: "ABC" });
  });

  it("does not refresh again for replayed completion events already applied", async () => {
    state.get.mockResolvedValueOnce(page(31, 60));
    await render();
    await act(async () => {
      const listener = state.watch.mock.calls.at(-1)![2];
      listener({ id: 61, runId: "r31", payload: { type: "status", status: "completed" } });
      await new Promise((resolve) => setTimeout(resolve, 170));
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      state.watch.mock.calls.at(-1)![2]({
        id: 61,
        runId: "r31",
        payload: { type: "status", status: "completed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 170));
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

it("uses buffered coverage when newly loaded history starts at the original subscription cursor", async () => {
  await render();
  await act(async () => {
    state.watch.mock.calls.at(-1)![2]({
      id: 80,
      runId: "r31",
      payload: { type: "status", status: "running" },
    });
  });
  const watches = state.watch.mock.calls.length;
  state.get.mockResolvedValueOnce({ ...page(1, 30, false), cursor: 60 });
  await act(async () => {
    await hook.loadOlder();
  });
  expect(hook.runs.r1).toBeDefined();
  expect(state.watch).toHaveBeenCalledTimes(watches);
});

it("rewinds to the original subscription cursor when older history exceeds buffer coverage", async () => {
  await render();
  await act(async () => {
    const listener = state.watch.mock.calls.at(-1)![2];
    for (let id = 61; id <= 2061; id++)
      listener({ id, runId: "r31", payload: { type: "status", status: "running" } });
  });
  const watches = state.watch.mock.calls.length;
  state.get.mockResolvedValueOnce({ ...page(1, 30, false), cursor: 60 });
  await act(async () => {
    await hook.loadOlder();
  });
  expect(state.watch).toHaveBeenCalledTimes(watches + 1);
  expect(state.watch).toHaveBeenLastCalledWith("a", 60, expect.any(Function));
  await act(async () => {
    state.watch.mock.calls.at(-1)![2]({
      id: 61,
      runId: "r1",
      payload: { type: "status", status: "running" },
    });
  });
  expect(hook.runs.r1!.timeline.status).toBe("running");
});
