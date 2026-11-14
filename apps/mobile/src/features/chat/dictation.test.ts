import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: new Map<string, Set<(event?: unknown) => void>>(),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  permission: vi.fn(),
  available: vi.fn(),
}));

vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("expo-speech-recognition", async () => {
  const { useEffect } = await import("react");
  return {
    ExpoSpeechRecognitionModule: {
      requestPermissionsAsync: state.permission,
      isRecognitionAvailable: state.available,
      start: state.start,
      stop: state.stop,
      abort: state.abort,
      addListener: (name: string, callback: (event?: unknown) => void) => {
        const listeners = state.events.get(name) ?? new Set();
        listeners.add(callback);
        state.events.set(name, listeners);
        return { remove: () => listeners.delete(callback) };
      },
    },
    useSpeechRecognitionEvent: (name: string, callback: (event?: unknown) => void) => {
      useEffect(() => {
        const listeners = state.events.get(name) ?? new Set();
        listeners.add(callback);
        state.events.set(name, listeners);
        return () => {
          listeners.delete(callback);
        };
      }, [name, callback]);
    },
  };
});

import { useDictation } from "./dictation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReactTestRenderer[] = [];

async function mount(onText = vi.fn(), onError = vi.fn()) {
  let hook!: ReturnType<typeof useDictation>;
  function Probe() {
    hook = useDictation({ onText, onError });
    return null;
  }
  await act(async () => {
    roots.push(create(createElement(Probe)));
  });
  return {
    get hook() {
      return hook;
    },
    onText,
    onError,
  };
}

async function emit(name: string, event?: unknown) {
  await act(async () => {
    for (const listener of [...(state.events.get(name) ?? [])]) listener(event);
  });
}
const result = (transcript: string, isFinal = true) => ({ isFinal, results: [{ transcript }] });

beforeEach(() => {
  vi.clearAllMocks();
  state.events.clear();
  state.permission.mockResolvedValue({ granted: true });
  state.available.mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  await emit("end");
});

describe("dictation", () => {
  it("cancels from a cleanup registered before listening began", async () => {
    const composer = await mount();
    const cleanup = composer.hook.cancel;
    await act(async () => {
      await composer.hook.start("Draft");
    });
    await emit("start");
    expect(composer.hook.listening).toBe(true);
    await act(async () => {
      cleanup();
    });
    expect(state.abort).toHaveBeenCalledOnce();
    expect(composer.hook.listening).toBe(false);
  });

  it("keeps final and interim speech after the existing draft", async () => {
    const composer = await mount();
    await act(async () => {
      await composer.hook.start("Draft");
    });
    await emit("result", result("hello"));
    await emit("result", result("world", false));
    expect(composer.onText.mock.calls.map(([text]) => text)).toEqual([
      "Draft hello",
      "Draft hello world",
    ]);
  });

  it("keeps text added while you speak after what you go on saying", async () => {
    const composer = await mount();
    await act(async () => {
      await composer.hook.start("Draft");
    });
    await emit("start");
    await emit("result", result("hello", false));
    composer.hook.append("Book it");
    await emit("result", result("hello there", false));
    await emit("result", result("hello there"));
    composer.hook.append("And lunch");
    await emit("result", result("thanks", false));
    expect(composer.onText.mock.calls.map(([text]) => text)).toEqual([
      "Draft hello",
      "Draft hello there\n\nBook it",
      "Draft hello there\n\nBook it",
      "Draft hello there thanks\n\nBook it\n\nAnd lunch",
    ]);
  });

  it("forgets added text once it starts again, and ignores text added while it isn't listening", async () => {
    const composer = await mount();
    composer.hook.append("Ignored");
    await act(async () => {
      await composer.hook.start("Draft");
    });
    await emit("result", result("hello"));
    composer.hook.append("Book it");
    await emit("end");
    await act(async () => {
      await composer.hook.start("Next");
    });
    await emit("result", result("again"));
    expect(composer.onText.mock.calls.map(([text]) => text)).toEqual(["Draft hello", "Next again"]);
  });

  it("only updates the composer that started recognition while other chats stay mounted", async () => {
    const hidden = await mount();
    const active = await mount();
    await act(async () => {
      await active.hook.start("Visible draft");
    });
    await emit("start");
    await emit("result", result("hello"));
    expect(hidden.onText).not.toHaveBeenCalled();
    expect(hidden.hook.listening).toBe(false);
    expect(active.onText).toHaveBeenCalledWith("Visible draft hello");
    expect(active.hook.listening).toBe(true);
    await emit("error", { error: "network" });
    expect(hidden.onError).not.toHaveBeenCalled();
    expect(active.onError).toHaveBeenCalledOnce();
    expect(active.hook.listening).toBe(false);
  });

  it("does not let a hidden composer's cleanup or Stop abort the active recognizer", async () => {
    const hidden = await mount();
    const active = await mount();
    await act(async () => {
      await active.hook.start("Draft");
    });
    await act(async () => {
      hidden.hook.cancel();
      hidden.hook.stop();
    });
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled();
    await emit("result", result("still listening"));
    expect(active.onText).toHaveBeenCalledWith("Draft still listening");
  });

  it("ignores late results after leaving a composer and permits another chat to dictate", async () => {
    const first = await mount();
    const second = await mount();
    await act(async () => {
      await first.hook.start("First");
      first.hook.cancel();
    });
    await emit("result", result("late"));
    expect(first.onText).not.toHaveBeenCalled();
    await emit("end");
    await act(async () => {
      await second.hook.start("Second");
    });
    await emit("result", result("hello"));
    expect(first.onText).not.toHaveBeenCalled();
    expect(second.onText).toHaveBeenCalledWith("Second hello");
  });

  it("waits for cancelled native recognition to end before assigning another composer", async () => {
    const first = await mount();
    const second = await mount();
    await act(async () => {
      await first.hook.start("First");
      first.hook.cancel();
    });
    const pending = second.hook.start("Second");
    await emit("error", { error: "aborted" });
    await emit("result", result("late first result"));
    expect(state.start).toHaveBeenCalledOnce();
    expect(second.onText).not.toHaveBeenCalled();
    await emit("end");
    await act(async () => {
      await pending;
    });
    expect(state.start).toHaveBeenCalledTimes(2);
    await emit("result", result("hello"));
    expect(second.onText).toHaveBeenCalledExactlyOnceWith("Second hello");
  });

  it("releases recognition if the native start throws", async () => {
    const composer = await mount();
    state.start.mockImplementationOnce(() => {
      throw new Error("native failed");
    });
    await act(async () => {
      await composer.hook.start("Draft");
    });
    expect(composer.onError).toHaveBeenCalledExactlyOnceWith(
      "Dictation couldn't start. Try again.",
    );
    await act(async () => {
      await composer.hook.start("Retry");
    });
    await emit("result", result("hello"));
    expect(composer.onText).toHaveBeenCalledExactlyOnceWith("Retry hello");
  });

  it("does not start if the composer loses focus while permission is pending", async () => {
    let grant!: (value: { granted: boolean }) => void;
    state.permission.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const composer = await mount();
    const pending = composer.hook.start("Draft");
    await act(async () => {
      composer.hook.cancel();
      grant({ granted: true });
      await pending;
    });
    expect(state.start).not.toHaveBeenCalled();
    await emit("result", result("late"));
    expect(composer.onText).not.toHaveBeenCalled();
  });

  it("keeps final results after Stop until the native end event releases recognition", async () => {
    const composer = await mount();
    await act(async () => {
      await composer.hook.start("Draft");
      composer.hook.stop();
    });
    await emit("result", result("final words"));
    await emit("end");
    await emit("result", result("too late"));
    expect(state.stop).toHaveBeenCalledOnce();
    expect(composer.onText).toHaveBeenCalledExactlyOnceWith("Draft final words");
    expect(composer.hook.listening).toBe(false);
  });
});
