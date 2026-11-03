import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: new Map<string, (event?: unknown) => void>(),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  permission: vi.fn(),
  available: vi.fn(),
}));

vi.mock("react", () => ({
  useState: () => [false, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync: state.permission,
    isRecognitionAvailable: state.available,
    start: state.start,
    stop: state.stop,
    abort: state.abort,
  },
  useSpeechRecognitionEvent: (name: string, callback: (event?: unknown) => void) =>
    state.events.set(name, callback),
}));

import { useDictation } from "./dictation";

beforeEach(() => {
  vi.clearAllMocks();
  state.events.clear();
  state.permission.mockResolvedValue({ granted: true });
  state.available.mockReturnValue(true);
});

describe("dictation", () => {
  it("cancels from a chat cleanup registered before listening began", async () => {
    const dictation = useDictation({ onText: vi.fn(), onError: vi.fn() });
    const cleanup = dictation.cancel;
    await dictation.start("Draft");
    state.events.get("start")!();
    cleanup();
    expect(state.abort).toHaveBeenCalledOnce();
  });

  it("keeps final and interim speech after the existing draft", async () => {
    const onText = vi.fn();
    const dictation = useDictation({ onText, onError: vi.fn() });
    await dictation.start("Draft");
    const result = state.events.get("result")!;
    result({ isFinal: true, results: [{ transcript: "hello" }] });
    result({ isFinal: false, results: [{ transcript: "world" }] });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(["Draft hello", "Draft hello world"]);
  });
});
