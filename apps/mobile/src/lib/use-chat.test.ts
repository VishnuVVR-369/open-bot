import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cursor: 5,
  focus: [] as (() => (() => void) | undefined)[],
  watch: vi.fn<(_chatId: string, _cursor: number, _listener: unknown) => () => void>(() => vi.fn()),
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useEffect: vi.fn(),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => state.focus.push(effect),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { cursor: state.cursor } }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("./api", () => ({ api: {} }));
vi.mock("./query", () => ({ queryKeys: { chat: (id: string) => ["chat", id] } }));
vi.mock("./realtime", () => ({ useRealtime: () => ({ watchChat: state.watch }) }));
vi.mock("./use-chat-visibility", () => ({ useChatVisibility: vi.fn() }));

import { useChat } from "./use-chat";

beforeEach(() => {
  vi.clearAllMocks();
  state.focus = [];
  state.cursor = 5;
});

describe("chat stream focus", () => {
  it("does not watch a mounted chat before it is focused", () => {
    useChat("a");
    expect(state.watch).not.toHaveBeenCalled();
    const blur = state.focus[0]!();
    expect(state.watch).toHaveBeenCalledWith("a", 5, expect.any(Function));
    blur?.();
    expect(state.watch.mock.results[0]!.value).toHaveBeenCalledOnce();
  });

  it("a refreshed off-screen chat cannot replace the visible chat's stream", () => {
    useChat("a");
    state.focus.at(-1)!()?.();
    useChat("b");
    state.focus.at(-1)!();
    state.cursor = 20;
    useChat("a");
    expect(state.watch.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });
});
