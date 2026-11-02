import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effects: [] as (() => () => void)[],
  navigation: { isFocused: vi.fn(() => true) },
  app: {
    currentState: "active",
    addEventListener: vi.fn(),
  },
  listeners: new Set<(state: string) => void>(),
  clear: vi.fn<(_chatId: string, _isVisible: () => boolean) => Promise<void>>(),
  visible: null as string | null,
}));

vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => () => void) => state.effects.push(effect),
  useNavigation: () => state.navigation,
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("react-native", () => ({ AppState: state.app }));
vi.mock("../push/notifications", () => ({ clearChatNotifications: state.clear }));
vi.mock("./realtime", () => ({
  visibleChat: {
    get: () => state.visible,
    set: (chatId: string | null) => (state.visible = chatId),
  },
}));

import { useChatVisibility } from "./use-chat-visibility";

function focus(chatId: string) {
  useChatVisibility(chatId);
  return state.effects.at(-1)!();
}

function appState(value: string) {
  state.app.currentState = value;
  for (const listener of state.listeners) listener(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.listeners.clear();
  state.visible = null;
  state.app.currentState = "active";
  state.navigation.isFocused.mockReturnValue(true);
  state.clear.mockResolvedValue(undefined);
  state.app.addEventListener.mockImplementation((_event, listener) => {
    state.listeners.add(listener);
    return { remove: () => state.listeners.delete(listener) };
  });
});

describe("chat notification focus", () => {
  it("does not clear notifications just because a chat mounts", () => {
    useChatVisibility("a");
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
    expect(state.visible).toBeNull();
  });

  it("clears only the focused chat on resume while earlier chats stay mounted", () => {
    const blurA = focus("a");
    blurA();
    const blurB = focus("b");
    state.clear.mockClear();

    appState("background");
    appState("active");

    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["b"]);
    expect(state.listeners.size).toBe(1);
    expect(state.visible).toBe("b");
    blurB();
    expect(state.listeners.size).toBe(0);
    expect(state.visible).toBeNull();
  });

  it("restores visibility and clearing when returning to a mounted chat", () => {
    const blurA = focus("a");
    const focusA = state.effects[0]!;
    blurA();
    const blurB = focus("b");
    blurB();
    state.clear.mockClear();
    const cleanup = focusA();

    expect(state.visible).toBe("a");
    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["a"]);
    cleanup();
  });

  it("checks navigation focus even before effect cleanup", () => {
    const cleanup = focus("a");
    const isVisible = state.clear.mock.calls[0]![1];
    state.navigation.isFocused.mockReturnValue(false);
    state.clear.mockClear();
    appState("active");

    expect(state.clear).not.toHaveBeenCalled();
    expect(isVisible()).toBe(false);
    cleanup();
  });

  it("invalidates pending clears on blur and backgrounding", () => {
    const cleanup = focus("a");
    const isVisible = state.clear.mock.calls[0]![1];
    expect(isVisible()).toBe(true);
    appState("background");
    expect(isVisible()).toBe(false);
    appState("active");
    cleanup();
    expect(isVisible()).toBe(false);
  });

  it("waits for the app to be active before clearing", () => {
    appState("background");
    const cleanup = focus("a");
    expect(state.clear).not.toHaveBeenCalled();
    appState("active");
    expect(state.clear).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("does not erase a newer chat's visibility during cleanup", () => {
    const blurA = focus("a");
    const blurB = focus("b");
    blurA();
    expect(state.visible).toBe("b");
    blurB();
  });
});
