// useChat's history: older pages on request, refreshed pages kept continuous, and when it may be
// marked read.
import type { ChatData } from "@open-bot/api";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  client,
  entry,
  hook,
  ids,
  page,
  refresh,
  render,
  resetChat,
  state,
  unmountChat,
} from "./use-chat.testing";
import { useChatVisibility } from "./use-chat-visibility";

beforeEach(resetChat);
afterEach(unmountChat);

describe("chat history", () => {
  it("keeps a continuous history when a new reply moves the latest page forward", async () => {
    state.get.mockResolvedValue(page(1, 30, false));
    await render();
    await act(async () => {
      await hook.loadOlder();
    });
    await refresh(page(32, 61));
    expect(ids()).toEqual(Array.from({ length: 61 }, (_, index) => `r${index + 1}`));
    expect(hook.hasMore).toBe(false);
    expect(state.get).toHaveBeenCalledExactlyOnceWith({ chatId: "a", before: entry(31).at });
  });

  it("retains displaced entries even before the user first requests an older page", async () => {
    await render();
    await refresh(page(32, 61));
    state.get.mockResolvedValue(page(1, 30, false));
    await act(async () => {
      await hook.loadOlder();
    });
    expect(state.get).toHaveBeenLastCalledWith({ chatId: "a", before: entry(31).at });
    expect(ids()).toHaveLength(61);
    expect(ids()).toContain("r31");
  });

  it("uses fresh run views without duplicating overlapping entries", async () => {
    await render();
    const updated = page(32, 61);
    const row = updated.entries[0]!;
    if (row.type === "run") row.run.rating = "up";
    await refresh(updated);
    expect(ids()).toHaveLength(31);
    expect(hook.runs.r32!.rating).toBe("up");
    expect(hook.runs.r31).toBeDefined();
  });

  it("keeps a newer snapshot when a previously requested history page finishes", async () => {
    let finish!: (data: ChatData) => void;
    state.get.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.loadOlder();
    });
    await refresh(page(32, 61));
    await act(async () => {
      finish(page(1, 30, false));
      await pending;
    });
    expect(ids()).toHaveLength(61);
    expect(hook.runs.r61).toBeDefined();
  });

  it("applies live events to a run loaded from an older page", async () => {
    state.get.mockResolvedValue(page(1, 30, false));
    await render();
    await act(async () => {
      await hook.loadOlder();
    });
    await act(async () => {
      state.watch.mock.calls.at(-1)![2]({
        id: 61,
        runId: "r1",
        payload: { type: "status", status: "running" },
      });
    });
    expect(hook.runs.r1!.timeline.status).toBe("running");
  });

  it("ignores an older page that completes after changing chats", async () => {
    let finish!: (data: ChatData) => void;
    state.get.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.loadOlder();
    });
    client.setQueryData(["chat", "b"], page(90, 91, false, "b"));
    await render({ chatId: "b" });
    await act(async () => {
      finish(page(1, 30, false));
      await pending;
    });
    expect(ids()).toEqual(["r90", "r91"]);
    expect(hook.hasMore).toBe(false);
  });
});

describe("refreshed history continuity", () => {
  it("fills every intervening page and finds a reply in the missing middle", async () => {
    state.get.mockResolvedValueOnce(page(1, 30, false));
    await render();
    await act(async () => {
      await hook.loadOlder();
    });
    let finish!: (data: ChatData) => void;
    state.get
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(page(32, 61));
    await refresh(page(92, 121));
    await render({ runId: "r75" });
    expect(state.scroll).not.toHaveBeenCalled();
    await act(async () => {
      finish(page(62, 91));
    });
    expect(ids()).toEqual(Array.from({ length: 121 }, (_, index) => `r${index + 1}`));
    expect(state.get.mock.calls.map(([input]) => input.before)).toEqual([
      entry(31).at,
      entry(92).at,
      entry(62).at,
    ]);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(46);
    expect(hook.hasMore).toBe(false);
  });

  it("keeps the continuous history and exposes a failed gap fetch for retry", async () => {
    await render();
    state.get.mockRejectedValueOnce(new Error("offline"));
    await refresh(page(92, 121));
    expect(ids()).toHaveLength(30);
    expect(hook.error).toBeInstanceOf(Error);
    state.get
      .mockResolvedValueOnce(page(92, 121))
      .mockResolvedValueOnce(page(62, 91))
      .mockResolvedValueOnce(page(32, 61));
    await act(async () => {
      await hook.refetch();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(ids()).toHaveLength(91);
    expect(hook.error).toBeNull();
  });

  it("discards an intervening page after switching chats", async () => {
    let finish!: (data: ChatData) => void;
    state.get.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await refresh(page(92, 121));
    client.setQueryData(["chat", "b"], page(5, 6, false, "b"));
    await render({ chatId: "b" });
    await act(async () => {
      finish(page(32, 91));
    });
    expect(ids()).toEqual(["r5", "r6"]);
  });
});

describe("history read eligibility", () => {
  const ready = () => (vi.mocked(useChatVisibility).mock.calls.at(-1)?.[2] ?? null) !== null;

  it("waits for initial history and keeps failed requests unread until retry succeeds", async () => {
    client.removeQueries({ queryKey: ["chat", "a"] });
    let reject!: (error: Error) => void;
    state.get.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await render();
    expect(ready()).toBe(false);
    await act(async () => {
      reject(new Error("offline"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ready()).toBe(false);
    state.get.mockResolvedValueOnce(page(31, 60));
    await act(async () => {
      await hook.refetch();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ready()).toBe(true);
  });

  it("waits for a disjoint refresh to fill its gap, including after a failed attempt", async () => {
    await render();
    expect(ready()).toBe(true);
    let reject!: (error: Error) => void;
    state.get.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await refresh(page(92, 121));
    expect(ready()).toBe(false);
    await act(async () => reject(new Error("offline")));
    expect(ready()).toBe(false);
    state.get.mockResolvedValueOnce(page(62, 91)).mockResolvedValueOnce(page(32, 61));
    await refresh(page(92, 121));
    expect(ready()).toBe(true);
  });
});
