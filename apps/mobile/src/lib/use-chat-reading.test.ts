import type { ChatData, ChatEntry, RunView } from "@open-bot/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  focused: true,
  navigation: { isFocused: vi.fn(() => true) },
  app: { currentState: "active", addEventListener: vi.fn() },
  listeners: new Set<(state: string) => void>(),
  get: vi.fn<(_input: { chatId: string; before?: string }) => Promise<ChatData>>(),
  markRead: vi.fn<(_input: { chatId: string }) => Promise<{ ok: boolean }>>(() =>
    Promise.resolve({ ok: true }),
  ),
  clear: vi.fn<(_chatId: string, _isVisible: () => boolean) => Promise<void>>(),
  visible: null as string | null,
  watch: vi.fn(() => () => {}),
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => (() => void) | void) => {
      const focused = state.focused;
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
    useNavigation: () => state.navigation,
  };
});
vi.mock("./api", () => ({ api: { chats: { get: state.get, markRead: state.markRead } } }));
vi.mock("./query", () => ({ queryKeys: { chats: ["chats"], chat: (id: string) => ["chat", id] } }));
vi.mock("react-native", () => ({ AppState: state.app }));
vi.mock("../push/notifications", () => ({ clearChatNotifications: state.clear }));
vi.mock("./realtime", () => ({
  useRealtime: () => ({ watchChat: state.watch }),
  visibleChat: {
    get: () => state.visible,
    set: (chatId: string | null) => (state.visible = chatId),
  },
}));

import { useChat } from "./use-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient;
let root: ReactTestRenderer | null;
let hook: ReturnType<typeof useChat>;
function entry(id: number): ChatEntry {
  const at = new Date(Date.UTC(2026, 10, 4, 0, 0, id)).toISOString();
  const run: RunView = {
    id: `r${id}`,
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
function page(last = 1, chatId = "a"): ChatData {
  return {
    chat: {
      id: chatId,
      kind: "direct",
      title: "Rex",
      botId: "b",
      main: true,
      memberIds: ["b"],
      lastActivityAt: entry(last).at,
      active: false,
      unread: true,
      preview: null,
    },
    members: [],
    entries: Array.from({ length: last }, (_, index) => entry(index + 1)),
    cursor: last,
    hasMore: false,
    helper: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function Probe({ chatId }: { chatId: string }) {
  hook = useChat(chatId);
  return null;
}
async function render(chatId = "a") {
  await act(async () => {
    const tree = createElement(QueryClientProvider, { client }, createElement(Probe, { chatId }));
    if (root) root.update(tree);
    else root = create(tree);
    await vi.runAllTimersAsync();
  });
}
async function settle(action: () => void) {
  await act(async () => {
    action();
    // Drain React Query's scheduled observer notifications as well as the request microtasks.
    await vi.runAllTimersAsync();
  });
}
async function appState(value: string) {
  await settle(() => {
    state.app.currentState = value;
    for (const listener of state.listeners) listener(value);
  });
}
function expectUnread() {
  expect(state.markRead).not.toHaveBeenCalled();
  expect(state.clear).not.toHaveBeenCalled();
  expect(state.visible).toBeNull();
  expect(client.getQueryData<{ unread: boolean }[]>(["chats"])?.[0]?.unread).toBe(true);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.get.mockReset();
  state.focused = true;
  state.navigation.isFocused.mockReturnValue(true);
  state.app.currentState = "active";
  state.listeners.clear();
  state.visible = null;
  state.clear.mockResolvedValue(undefined);
  state.app.addEventListener.mockImplementation((_event, listener) => {
    state.listeners.add(listener);
    return { remove: () => state.listeners.delete(listener) };
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["chat", "a"], page());
  client.setQueryData(["chats"], [page().chat]);
  root = null;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client.clear();
  vi.useRealTimers();
});

describe("fresh visible chat history", () => {
  it("does not read cached history on focus until fresh history has loaded", async () => {
    const request = deferred<ChatData>();
    state.get.mockReturnValue(request.promise);
    await render();
    expect(state.get).toHaveBeenCalledWith({ chatId: "a" });
    expectUnread();
    await settle(() => request.resolve(page(2)));
    expect(hook.entries).toHaveLength(2);
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
    expect(state.clear).toHaveBeenCalled();
    expect(state.visible).toBe("a");
  });

  it("keeps cached replies unread after failed foreground catch-up and supports retry", async () => {
    const request = deferred<ChatData>();
    state.get.mockReturnValue(request.promise);
    await render();
    await settle(() => request.reject(new Error("offline")));
    expectUnread();
    expect(hook.error).toBeInstanceOf(Error);
    state.get.mockResolvedValueOnce(page(2));
    await act(async () => {
      await hook.refetch();
      await vi.runAllTimersAsync();
    });
    expect(hook.entries).toHaveLength(2);
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });

  it.each(["success", "failure"])("requires a new catch-up after resume: %s", async (outcome) => {
    state.get.mockResolvedValueOnce(page());
    await render();
    expect(state.markRead).toHaveBeenCalled();
    const pendingClear = state.clear.mock.calls.at(-1)![1];
    await appState("background");
    state.markRead.mockClear();
    state.clear.mockClear();
    client.setQueryData(["chats"], [page(2).chat]);
    const request = deferred<ChatData>();
    state.get.mockReturnValueOnce(request.promise);
    await appState("active");
    expectUnread();
    expect(pendingClear()).toBe(false);
    if (outcome === "failure") {
      await settle(() => request.reject(new Error("offline")));
      expectUnread();
    } else {
      await settle(() => request.resolve(page(2)));
      expect(hook.entries).toHaveLength(2);
      expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
      expect(state.clear).toHaveBeenCalled();
    }
  });

  it("waits for an initial uncached history request", async () => {
    client.removeQueries({ queryKey: ["chat", "a"] });
    const request = deferred<ChatData>();
    state.get.mockReturnValue(request.promise);
    await render();
    expectUnread();
    await settle(() => request.resolve(page(2)));
    expect(hook.entries).toHaveLength(2);
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });

  it("waits for a disjoint catch-up to load its intervening history", async () => {
    const gap = deferred<ChatData>();
    state.get.mockResolvedValueOnce({ ...page(3), entries: [entry(3)], hasMore: true });
    state.get.mockReturnValueOnce(gap.promise);
    await render();
    expect(hook.loading).toBe(true);
    expectUnread();
    await settle(() => gap.resolve(page(2)));
    expect(hook.entries).toHaveLength(3);
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });

  it("does not accept a catch-up that finishes after blur or while another chat is focused", async () => {
    const first = deferred<ChatData>();
    state.get.mockReturnValueOnce(first.promise);
    await render();
    state.focused = false;
    await render();
    await settle(() => first.resolve(page(2)));
    expectUnread();
    const second = deferred<ChatData>();
    state.get.mockReturnValue(second.promise);
    state.focused = true;
    await render("b");
    expectUnread();
    await settle(() => second.resolve(page(2, "b")));
    expect(state.markRead.mock.calls.map(([input]) => input.chatId)).toEqual(["b"]);
    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["b"]);
  });

  it("invalidates an in-flight foreground catch-up across repeated app transitions", async () => {
    const first = deferred<ChatData>();
    const second = deferred<ChatData>();
    state.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await appState("inactive");
    await appState("background");
    await appState("active");
    await settle(() => first.resolve(page(2)));
    expectUnread();
    await settle(() => second.resolve(page(3)));
    expect(hook.entries).toHaveLength(3);
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });

  it("does not fetch or clear in the background until the focused chat becomes active", async () => {
    state.app.currentState = "background";
    await render();
    expect(state.get).not.toHaveBeenCalled();
    expectUnread();
    const request = deferred<ChatData>();
    state.get.mockReturnValueOnce(request.promise);
    await appState("active");
    expectUnread();
    await settle(() => request.resolve(page(2)));
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });

  it("requires another fresh request when returning to a previously read mounted chat", async () => {
    state.get.mockResolvedValueOnce(page());
    await render();
    state.focused = false;
    await render();
    state.markRead.mockClear();
    state.clear.mockClear();
    client.setQueryData(["chats"], [page(2).chat]);
    const request = deferred<ChatData>();
    state.get.mockReturnValueOnce(request.promise);
    state.focused = true;
    await render();
    expectUnread();
    await settle(() => request.resolve(page(2)));
    expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
  });
});

it("replaces an unfocused initial request before accepting history on focus", async () => {
  client.removeQueries({ queryKey: ["chat", "a"] });
  state.focused = false;
  const hidden = deferred<ChatData>();
  const fresh = deferred<ChatData>();
  state.get.mockReturnValueOnce(hidden.promise).mockReturnValue(fresh.promise);
  await render();
  expectUnread();
  state.focused = true;
  await render();
  await settle(() => hidden.resolve(page()));
  expectUnread();
  await settle(() => fresh.resolve(page(2)));
  expect(hook.entries).toHaveLength(2);
  expect(state.markRead).toHaveBeenCalledWith({ chatId: "a" });
});
