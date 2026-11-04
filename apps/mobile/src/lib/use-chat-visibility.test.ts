import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  focused: true,
  navigation: { isFocused: vi.fn(() => true) },
  app: { currentState: "active", addEventListener: vi.fn() },
  listeners: new Set<(state: string) => void>(),
  clear: vi.fn<(_chatId: string, _isVisible: () => boolean) => Promise<void>>(),
  visible: null as string | null,
  markRead: vi.fn(() => Promise.resolve({ ok: true })),
  refresh: vi.fn<() => Promise<number>>(),
  client: { setQueryData: vi.fn() },
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
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => state.client }));
vi.mock("./api", () => ({ api: { chats: { markRead: state.markRead } } }));
vi.mock("./query", () => ({ queryKeys: { chats: ["chats"] } }));
vi.mock("react-native", () => ({ AppState: state.app }));
vi.mock("../push/notifications", () => ({ clearChatNotifications: state.clear }));
vi.mock("./realtime", () => ({
  visibleChat: {
    get: () => state.visible,
    set: (chatId: string | null) => (state.visible = chatId),
  },
}));

import { useChatVisibility } from "./use-chat-visibility";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | null;
function Probe({ chatId, finished, ready }: { chatId: string; finished: number; ready: boolean }) {
  useChatVisibility(chatId, finished, ready ? 1 : null, state.refresh);
  return null;
}
async function render(chatId = "a", finished = 0, ready = true) {
  await act(async () => {
    const tree = createElement(Probe, { chatId, finished, ready });
    if (root) root.update(tree);
    else root = create(tree);
  });
}
async function appState(value: string) {
  await act(async () => {
    state.app.currentState = value;
    for (const listener of state.listeners) listener(value);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = null;
  state.focused = true;
  state.listeners.clear();
  state.visible = null;
  state.app.currentState = "active";
  state.navigation.isFocused.mockReturnValue(true);
  state.clear.mockResolvedValue(undefined);
  state.refresh.mockReset().mockResolvedValue(1);
  state.app.addEventListener.mockImplementation((_event, listener) => {
    state.listeners.add(listener);
    return { remove: () => state.listeners.delete(listener) };
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
});

describe("chat notification focus", () => {
  it("does not clear or read an unfocused mounted chat", async () => {
    state.focused = false;
    await render();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.markRead).not.toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
    expect(state.visible).toBeNull();
  });

  it("clears only the focused chat on resume", async () => {
    await render();
    state.focused = false;
    await render();
    await render("b");
    state.focused = true;
    await render("b");
    state.clear.mockClear();
    await appState("background");
    await appState("active");
    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["b"]);
    expect(state.listeners.size).toBe(1);
    expect(state.visible).toBe("b");
  });

  it("restores visibility and clearing when returning to a mounted chat", async () => {
    await render();
    state.focused = false;
    await render();
    expect(state.visible).toBeNull();
    expect(state.listeners.size).toBe(0);
    state.clear.mockClear();
    state.focused = true;
    await render();
    expect(state.visible).toBe("a");
    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["a"]);
  });

  it("checks navigation focus even before effect cleanup", async () => {
    await render();
    const isVisible = state.clear.mock.calls[0]![1];
    state.navigation.isFocused.mockReturnValue(false);
    state.clear.mockClear();
    state.markRead.mockClear();
    await appState("active");
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.markRead).not.toHaveBeenCalled();
    expect(isVisible()).toBe(false);
  });

  it("invalidates pending clears on blur and backgrounding", async () => {
    await render();
    const isVisible = state.clear.mock.calls[0]![1];
    expect(isVisible()).toBe(true);
    await appState("background");
    expect(isVisible()).toBe(false);
    await appState("active");
    state.focused = false;
    await render();
    expect(isVisible()).toBe(false);
  });

  it("waits for the app to be active before clearing", async () => {
    await appState("background");
    await render();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.markRead).not.toHaveBeenCalled();
    await appState("active");
    expect(state.clear).toHaveBeenCalledTimes(1);
    expect(state.markRead).toHaveBeenCalledTimes(1);
  });

  it("does not erase a newer chat's visibility during cleanup", async () => {
    await render();
    state.visible = "b";
    state.focused = false;
    await render();
    expect(state.visible).toBe("b");
  });
});

describe("reading a chat", () => {
  it("marks loaded history read on focus, completion and resume", async () => {
    await render();
    expect(state.markRead).toHaveBeenCalledExactlyOnceWith({ chatId: "a" });
    await render("a", 1);
    expect(state.markRead).toHaveBeenCalledTimes(2);
    await appState("background");
    await render("a", 2);
    expect(state.markRead).toHaveBeenCalledTimes(2);
    await appState("active");
    expect(state.markRead).toHaveBeenCalledTimes(3);
    state.focused = false;
    await render("a", 3);
    expect(state.markRead).toHaveBeenCalledTimes(3);
  });

  it("waits for successful history before reading or clearing on focus and resume", async () => {
    await render("a", 0, false);
    await appState("background");
    await appState("active");
    await render("a", 1, false);
    expect(state.markRead).not.toHaveBeenCalled();
    expect(state.client.setQueryData).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.visible).toBeNull();
    await render("a", 1, true);
    expect(state.markRead).toHaveBeenCalledExactlyOnceWith({ chatId: "a" });
    expect(state.clear).toHaveBeenCalledOnce();
  });

  it("stops reading after a refresh fails until successful visible history returns", async () => {
    await render();
    state.markRead.mockClear();
    state.clear.mockClear();
    await render("a", 0, false);
    await appState("background");
    await appState("active");
    await render("a", 1, false);
    expect(state.markRead).not.toHaveBeenCalled();
    expect(state.clear).not.toHaveBeenCalled();
    state.focused = false;
    await render("a", 1, true);
    expect(state.markRead).not.toHaveBeenCalled();
    state.focused = true;
    await render("a", 1, true);
    expect(state.markRead).toHaveBeenCalledOnce();
  });
});
