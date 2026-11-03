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
vi.mock("./use-chat-visibility", () => ({ useChatVisibility: vi.fn() }));

import { useChat } from "./use-chat";
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
    expect(state.watch).toHaveBeenLastCalledWith("a", 61, expect.any(Function));
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
