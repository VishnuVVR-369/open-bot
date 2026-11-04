import type { ChatData, ChatEntry, RunView, StreamRunEvent } from "@open-bot/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useCallback } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  focused: true,
  get: vi.fn<(_input: { chatId: string; before?: string }) => Promise<ChatData>>(),
  watch: vi.fn<
    (_chatId: string, _cursor: number, _listener: (event: StreamRunEvent) => void) => () => void
  >(() => vi.fn()),
  scroll: vi.fn(),
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => (() => void) | void) => {
      const focused = state.focused;
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});
vi.mock("./api", () => ({ api: { chats: { get: state.get } } }));
vi.mock("./query", () => ({ queryKeys: { chat: (id: string) => ["chat", id] } }));
vi.mock("./realtime", () => ({ useRealtime: () => ({ watchChat: state.watch }) }));
vi.mock("./use-chat-visibility", () => ({
  useChatVisibility: vi.fn(
    (
      _chatId: string,
      _finished: number,
      _historyVersion: number | null,
      refresh: () => Promise<number>,
    ) =>
      async () => {
        await refresh();
      },
  ),
}));

import { useChat } from "./use-chat";
import { useChatVisibility } from "./use-chat-visibility";
import { useChatRunTarget } from "./use-chat-run-target";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient;
let root: ReactTestRenderer | null;
let hook: ReturnType<typeof useChat>;

function entry(number: number): ChatEntry {
  const at = new Date(Date.UTC(2026, 10, 3, 0, 0, number)).toISOString();
  const run: RunView = {
    id: `r${number}`,
    botId: "b",
    trigger: "user",
    messageId: null,
    parentRunId: null,
    fromBotId: null,
    authMode: null,
    scheduleTitle: null,
    triggerTitle: null,
    automationPrompt: null,
    rating: null,
    usage: null,
    createdAt: at,
    startedAt: at,
    completedAt: at,
    timeline: { status: "completed", items: [] },
  };
  return { type: "run", at, run };
}
function page(first: number, last: number, hasMore = first > 1, chatId = "a"): ChatData {
  return {
    chat: {
      id: chatId,
      kind: "direct",
      title: "Rex",
      botId: "b",
      memberIds: ["b"],
      lastActivityAt: entry(last).at,
      active: false,
      unread: false,
      preview: null,
    },
    members: [],
    entries: Array.from({ length: last - first + 1 }, (_, index) => entry(first + index)),
    cursor: last,
    hasMore,
    helper: null,
  };
}
function Probe({ chatId = "a", runId }: { chatId?: string; runId?: string }) {
  hook = useChat(chatId);
  const scrollToIndex = useCallback((index: number) => state.scroll(index), []);
  useChatRunTarget({
    chatId,
    runId,
    items: [...hook.entries].reverse(),
    oldest: hook.entries[0]?.at,
    hasMore: hook.hasMore,
    loading: hook.loading || hook.loadingOlder || Boolean(hook.error),
    loadOlder: hook.loadOlder,
    scrollToIndex,
  });
  return null;
}
async function render(props: { chatId?: string; runId?: string } = {}) {
  await act(async () => {
    const tree = createElement(QueryClientProvider, { client }, createElement(Probe, props));
    if (root) root.update(tree);
    else root = create(tree);
  });
}
async function refresh(data: ChatData) {
  await act(async () => {
    client.setQueryData(["chat", data.chat.id], data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const ids = () => hook.entries.map((item) => (item.type === "run" ? item.run.id : item.message.id));

beforeEach(() => {
  vi.clearAllMocks();
  state.focused = true;
  state.get.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["chat", "a"], page(31, 60));
  root = null;
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  client.clear();
});

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

describe("links to replies", () => {
  it("loads as many older pages as necessary, then scrolls to the requested reply once", async () => {
    state.get.mockResolvedValueOnce(page(16, 30)).mockResolvedValueOnce(page(1, 15, false));
    await render({ runId: "r5" });
    expect(state.get.mock.calls.map(([input]) => input.before)).toEqual([
      entry(31).at,
      entry(16).at,
    ]);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
    await refresh(page(32, 61));
    expect(state.scroll).toHaveBeenCalledOnce();
  });

  it("handles the newest reply at index zero without requesting history", async () => {
    await render({ runId: "r60" });
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(0);
    expect(state.get).not.toHaveBeenCalled();
  });

  it("stops at the beginning if the linked reply no longer exists", async () => {
    state.get.mockResolvedValue(page(1, 30, false));
    await render({ runId: "gone" });
    expect(state.get).toHaveBeenCalledOnce();
    expect(state.scroll).not.toHaveBeenCalled();
  });

  it("waits for an explicit retry after a page fails, then continues to the reply", async () => {
    state.get.mockRejectedValueOnce(new Error("offline"));
    await render({ runId: "r5" });
    expect(state.get).toHaveBeenCalledOnce();
    expect(hook.olderError).toBeInstanceOf(Error);
    state.get.mockResolvedValueOnce(page(16, 30)).mockResolvedValueOnce(page(1, 15, false));
    await act(async () => {
      await hook.loadOlder();
    });
    expect(state.get).toHaveBeenCalledTimes(3);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
    expect(hook.olderError).toBeNull();
  });

  it("does not fetch linked history while the chat is hidden", async () => {
    state.focused = false;
    state.get.mockResolvedValue(page(1, 30, false));
    await render({ runId: "r5" });
    expect(state.get).not.toHaveBeenCalled();
    state.focused = true;
    await render({ runId: "r5" });
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith(55);
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
