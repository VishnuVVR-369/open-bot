// What the useChat tests share: the mocked API, router and realtime stream (`state`), a probe that
// renders the hook with `useChatRunTarget`, chat pages to load, and the per-test setup.
// Import it before the code under test, so its mocks are in place first.
import type { ChatData, ChatEntry, RunView, StreamRunEvent } from "@open-bot/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useCallback } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { vi } from "vitest";

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
vi.mock("../../lib/api", () => ({ api: { chats: { get: state.get } } }));
vi.mock("../../lib/query", () => ({ queryKeys: { chat: (id: string) => ["chat", id] } }));
vi.mock("../../lib/realtime", () => ({ useRealtime: () => ({ watchChat: state.watch }) }));
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
import { useChatRunTarget } from "./use-chat-run-target";

/** The mocks' state: whether the screen is focused, and the API, stream and scroll stand-ins. */
export { state };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export let client: QueryClient;
let root: ReactTestRenderer | null;
export let hook: ReturnType<typeof useChat>;

export function entry(number: number): ChatEntry {
  const at = new Date(Date.UTC(2026, 10, 3, 0, 0, number)).toISOString();
  const run: RunView = {
    id: `r${number}`,
    teammateId: "b",
    trigger: "user",
    messageId: null,
    parentRunId: null,
    fromTeammateId: null,
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
export function page(first: number, last: number, hasMore = first > 1, chatId = "a"): ChatData {
  return {
    chat: {
      id: chatId,
      kind: "direct",
      title: "Rex",
      teammateId: "b",
      main: true,
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
export async function render(props: { chatId?: string; runId?: string } = {}) {
  await act(async () => {
    const tree = createElement(QueryClientProvider, { client }, createElement(Probe, props));
    if (root) root.update(tree);
    else root = create(tree);
  });
}
export async function refresh(data: ChatData) {
  await act(async () => {
    client.setQueryData(["chat", data.chat.id], data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
export const ids = () =>
  hook.entries.map((item) => (item.type === "run" ? item.run.id : item.message.id));

/** Before each test: mocks cleared, focused, and chat a's latest page (31 to 60) cached. */
export function resetChat(): void {
  vi.clearAllMocks();
  state.focused = true;
  state.get.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["chat", "a"], page(31, 60));
  root = null;
}
/** After each test: the probe unmounted and the cache cleared. */
export async function unmountChat(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  client.clear();
}
