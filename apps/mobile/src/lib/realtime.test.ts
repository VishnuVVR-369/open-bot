import type { StreamRunEvent } from "@open-bot/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cursors: new Map<string, number>(), watched: [] as number[] }));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-network", () => ({ addNetworkStateListener: () => ({ remove: vi.fn() }) }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("./auth", () => ({ sessionCookie: vi.fn() }));
vi.mock("./config", () => ({ APP_URL: "https://bot.test" }));
vi.mock("./query", () => ({ keysForAppEvent: () => [], queryKeys: { teammates: ["teammates"] } }));
vi.mock("./live-stream", () => ({
  createLiveStream: ({ cursors }: { cursors: Map<string, number> }) => {
    state.cursors = cursors;
    return {
      close: vi.fn(),
      cursorOf: (id: string) => cursors.get(id) ?? 0,
      watch: (target: { chatId: string; cursor: number } | null) => {
        if (target) state.watched.push(Math.max(target.cursor, cursors.get(target.chatId) ?? 0));
      },
    };
  },
}));

import { RealtimeProvider, useRealtime } from "./realtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
});

it("honors a retained view's resume point when the transport has seen newer events", async () => {
  const client = new QueryClient();
  const listener = (_event: StreamRunEvent) => {};
  function Subscriber({ cursor }: { cursor: number }) {
    const { watchChat } = useRealtime();
    useEffect(() => watchChat("a", cursor, listener), [cursor, watchChat]);
    return null;
  }
  const tree = (cursor: number) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(RealtimeProvider, {
        enabled: true,
        onSignedOut: vi.fn(),
        children: createElement(Subscriber, { cursor }),
      }),
    );
  await act(async () => {
    root = create(tree(60));
  });
  state.cursors.set("a", 70);
  await act(async () => {
    root!.update(tree(50));
  });
  expect(state.watched.at(-1)).toBe(50);
  expect(state.cursors.get("a")).toBe(50);
  client.clear();
});
