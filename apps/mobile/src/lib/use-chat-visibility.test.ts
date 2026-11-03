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
  markRead: vi.fn(() => Promise.resolve({ ok: true })),
  setQueryData: vi.fn(),
  // useRef, kept across renders by call order, like React does.
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => () => void) => state.effects.push(effect),
  useNavigation: () => state.navigation,
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => effect(),
  useRef: (initial: unknown) => {
    const index = state.refIndex++;
    state.refs[index] ??= { current: initial };
    return state.refs[index];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: state.setQueryData }),
}));
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

/** Renders the hook as one mounted chat screen would, again and again. */
function useRendered(chatId: string, finished = 0) {
  state.refIndex = 0;
  useChatVisibility(chatId, finished);
}

function useFocusedChat(chatId: string) {
  state.refs = [];
  useRendered(chatId);
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
  state.refs = [];
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
    useRendered("a");
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
    expect(state.visible).toBeNull();
  });

  it("clears only the focused chat on resume while earlier chats stay mounted", () => {
    const blurA = useFocusedChat("a");
    blurA();
    const blurB = useFocusedChat("b");
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
    const blurA = useFocusedChat("a");
    const focusA = state.effects[0]!;
    blurA();
    const blurB = useFocusedChat("b");
    blurB();
    state.clear.mockClear();
    const cleanup = focusA();

    expect(state.visible).toBe("a");
    expect(state.clear.mock.calls.map(([chatId]) => chatId)).toEqual(["a"]);
    cleanup();
  });

  it("checks navigation focus even before effect cleanup", () => {
    const cleanup = useFocusedChat("a");
    const isVisible = state.clear.mock.calls[0]![1];
    state.navigation.isFocused.mockReturnValue(false);
    state.clear.mockClear();
    appState("active");

    expect(state.clear).not.toHaveBeenCalled();
    expect(isVisible()).toBe(false);
    cleanup();
  });

  it("invalidates pending clears on blur and backgrounding", () => {
    const cleanup = useFocusedChat("a");
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
    const cleanup = useFocusedChat("a");
    expect(state.clear).not.toHaveBeenCalled();
    appState("active");
    expect(state.clear).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("does not erase a newer chat's visibility during cleanup", () => {
    const blurA = useFocusedChat("a");
    const blurB = useFocusedChat("b");
    blurA();
    expect(state.visible).toBe("b");
    blurB();
  });
});

describe("reading a chat", () => {
  it("marks it read when you look at it, and when a reply finishes while you do", () => {
    const cleanup = useFocusedChat("a");
    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(state.markRead).toHaveBeenLastCalledWith({ chatId: "a" });

    useRendered("a", 1);
    expect(state.markRead).toHaveBeenCalledTimes(2);

    // A reply that finishes while you're elsewhere stays unread.
    appState("background");
    useRendered("a", 2);
    expect(state.markRead).toHaveBeenCalledTimes(2);
    appState("active");
    expect(state.markRead).toHaveBeenCalledTimes(3);

    cleanup();
    useRendered("a", 3);
    expect(state.markRead).toHaveBeenCalledTimes(3);
  });

  it("isn't marked read just because the screen mounts", () => {
    useRendered("a");
    expect(state.markRead).not.toHaveBeenCalled();
  });
});
