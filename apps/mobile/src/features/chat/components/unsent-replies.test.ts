import type { MessageView, TeammateSummary } from "@open-bot/api";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  onSent: vi.fn(),
  cancelNotification: vi.fn(async () => {}),
  /** Microphone permission, asked when you tap Dictate. */
  permission: vi.fn(),
  /** Speech recognition's listeners, by event. */
  speech: new Map<string, Set<(event?: unknown) => void>>(),
  /** The phone's AsyncStorage, as the stores see it. */
  stored: new Map<string, string>(),
  /** A phone on its side. */
  window: { width: 915, height: 412 },
}));
vi.mock("@notifee/react-native", () => ({
  default: { cancelNotification: state.cancelNotification },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-router", () => ({ useFocusEffect: () => {} }));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => state.window,
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "AlertCircle",
      "ArrowUp",
      "Camera",
      "ChevronDown",
      "FileUp",
      "Image",
      "Mic",
      "Paperclip",
      "Plus",
      "RotateCcw",
      "Square",
      "X",
    ].map((name) => [name, name]),
  ),
);
vi.mock("@/features/teammates/components/teammate-avatar", () => ({
  TeammateAvatar: "TeammateAvatar",
}));
vi.mock("@/components/sheet", () => ({ Sheet: "Sheet", SheetItem: "SheetItem" }));
vi.mock("@/components/text", () => ({ Text: "Text" }));
vi.mock("@/components/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ title, busy, disabled, ...props }: Record<string, unknown>) =>
      createElement(
        "Pressable",
        { ...props, disabled: Boolean(disabled || busy), accessibilityState: { busy } },
        title as string,
      ),
  };
});
vi.mock("@/lib/api", () => ({ api: { chats: { send: state.send } } }));
vi.mock("@/lib/errors", () => ({ errorMessage: () => "Couldn't send. Try again." }));
vi.mock("@/lib/haptics", () => ({
  haptics: {
    tap: () => {},
    press: () => {},
    success: () => {},
    warning: () => {},
    error: () => {},
  },
}));
vi.mock("@/lib/use-keyboard", () => ({ useKeyboardHeight: () => 0 }));
vi.mock("@/theme", () => ({
  fonts: { sans: "sans" },
  radius: { xl: 10, lg: 8 },
  space: (value: number) => value,
  useColors: () => ({}),
}));
vi.mock("@/theme/mix", () => ({ mix: () => "black" }));
// Android's speech recognition, for the real dictation hook.
vi.mock("expo-speech-recognition", async () => {
  const { useEffect } = await import("react");
  const listen = (name: string, callback: (event?: unknown) => void) => {
    const listeners = state.speech.get(name) ?? new Set();
    listeners.add(callback);
    state.speech.set(name, listeners);
    return () => void listeners.delete(callback);
  };
  return {
    ExpoSpeechRecognitionModule: {
      requestPermissionsAsync: state.permission,
      isRecognitionAvailable: () => true,
      start: () => {},
      stop: () => {},
      abort: () => {},
      addListener: (name: string, callback: (event?: unknown) => void) => ({
        remove: listen(name, callback),
      }),
    },
    useSpeechRecognitionEvent: (name: string, callback: (event?: unknown) => void) => {
      useEffect(() => listen(name, callback), [name, callback]);
    },
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.stored.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.stored.set(key, value),
  },
}));
// The real hooks and stores, which the app imports through the `@/` alias the tests don't have.
vi.mock("@/features/chat/dictation", () => import("../dictation"));
vi.mock("@/features/chat/drafts", () => import("../drafts"));
vi.mock("@/features/chat/recipients", () => import("../recipients"));
vi.mock("@/features/chat/unsent-replies", () => import("../unsent-replies"));
vi.mock("@/features/chat/use-attachments", () => import("../use-attachments"));
vi.mock("../uploads", () => ({ uploadAttachment: vi.fn() }));

import { readDraft } from "../drafts";
import { clearUnsentReplies, keepUnsentReply, unsentReplies } from "../unsent-replies";
import { Composer } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const member = (id: string, name: string) =>
  ({ id, name, color: "#000", emoji: "", role: "Helper" }) as TeammateSummary;
const rex = member("rex", "Rex");
const mia = member("mia", "Mia");
const group = { isGroup: true, members: [rex, mia] };
type Chat = { isGroup: boolean; members: TeammateSummary[] };

const composer = (chatId: string, chat: Chat = group) =>
  createElement(Composer, {
    chatId,
    placeholder: "Reply",
    activeRun: null,
    onSent: state.onSent,
    ...chat,
  });
const roots: ReactTestRenderer[] = [];
/** Opens a chat's composer; an earlier one stays open (another screen) unless it's closed. */
async function open(chatId: string, chat: Chat = group) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(composer(chatId, chat));
  });
  roots.push(root);
  return root;
}
const close = (root: ReactTestRenderer) => act(async () => root.unmount());

const hosts = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
const host = (root: ReactTestRenderer, id: string) => hosts(root, id)[0]!;
const press = (node: ReactTestInstance) => act(async () => void node.props.onPress());
const input = (root: ReactTestRenderer) => host(root, "composer-input");
const type = (root: ReactTestRenderer, text: string) =>
  act(async () => input(root).props.onChangeText(text));
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
/** Each card as it reads: its label, then its text. */
const cards = (root: ReactTestRenderer) =>
  hosts(root, "unsent-reply").map((card) => {
    const label = card.find((node) => node.props.testID === "unsent-reply-label");
    const text = card.findAll((node) => node.props.testID === "unsent-reply-text")[0];
    return [textOf(label), text ? textOf(text) : null];
  });
const inCard = (root: ReactTestRenderer, index: number, id: string) =>
  hosts(root, "unsent-reply")[index]!.findAll(
    (node) => typeof node.type === "string" && node.props.testID === id,
  )[0]!;
const keep = (chatId: string, text: string, teammateId: string | null = "rex") =>
  act(async () => {
    await keepUnsentReply({ id: `n:${text}`, chatId, text, teammateId, notificationId: "run-1" });
  });
/** A send of the composer's text that's on its way until the test delivers it. */
function sendOnItsWay() {
  let deliver!: () => void;
  state.send.mockReturnValueOnce(
    new Promise((resolve) => (deliver = () => resolve({ id: "sent" } as MessageView))),
  );
  return () => act(async () => deliver());
}
const speech = (name: string, event?: unknown) =>
  act(async () => {
    for (const listener of [...(state.speech.get(name) ?? [])]) listener(event);
  });

beforeEach(async () => {
  vi.clearAllMocks();
  state.permission.mockResolvedValue({ granted: true });
  state.send.mockResolvedValue({ id: "sent" } as MessageView);
  await clearUnsentReplies();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await close(root);
});

describe("a reply a notification couldn't send", () => {
  it("is a card of its own above the composer, never part of what you type", async () => {
    await keep("c1", "Book it");
    await keep("c1", "Lunch?", null);
    const root = await open("c1");
    expect(cards(root)).toEqual([
      ["Not sent - to Rex", "Book it"],
      ["Not sent - not addressed to anyone yet", "Lunch?"],
    ]);
    expect(input(root).props.value).toBe("");
    await type(root, "Hi all");
    await press(host(root, "send"));
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0]![0]).toMatchObject({ text: "Hi all", mentions: [] });
    expect(cards(root)).toHaveLength(2);
  });

  it("sends by id, to its own teammate, once from any composer, then goes with its notification", async () => {
    await keep("c1", "Book it");
    const first = await open("c1");
    const second = await open("c1");
    const deliver = sendOnItsWay();
    await press(inCard(first, 0, "unsent-reply-send"));
    expect(inCard(second, 0, "unsent-reply-send").props.disabled).toBe(true);
    await press(inCard(second, 0, "unsent-reply-send"));
    await deliver();
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0]![0]).toMatchObject({
      chatId: "c1",
      text: "Book it",
      mentions: ["rex"],
      attachments: [],
    });
    expect(cards(first)).toEqual([]);
    expect(cards(second)).toEqual([]);
    expect(state.cancelNotification).toHaveBeenCalledWith("n:Book it");
    expect(state.onSent).toHaveBeenCalledOnce();
  });

  it("stays when it fails, saying why, and is the same message when you try again", async () => {
    await keep("c1", "Book it");
    const root = await open("c1");
    state.send.mockRejectedValueOnce(new Error("offline"));
    await press(inCard(root, 0, "unsent-reply-send"));
    expect(textOf(hosts(root, "unsent-reply")[0]!)).toContain("Couldn't send. Try again.");
    await press(inCard(root, 0, "unsent-reply-send"));
    const [failed, retried] = state.send.mock.calls.map(([sent]) => sent.clientId);
    expect(retried).toBe(failed);
    expect(cards(root)).toEqual([]);
  });

  it("blocks only its own Send while its teammate isn't in the chat, until you pick from a list that scrolls", async () => {
    const big = Array.from({ length: 20 }, (_, i) => member(`m${i}`, `Member ${i}`));
    await keep("p1", "Book it", "gone");
    await keep("p1", "Lunch?", "m1");
    const root = await open("p1", { isGroup: true, members: big });
    expect(cards(root).map(([label]) => label)).toEqual([
      "Not sent - to a teammate who isn't in this chat",
      "Not sent - to Member 1",
    ]);
    expect(inCard(root, 0, "unsent-reply-send").props.disabled).toBe(true);
    expect(inCard(root, 1, "unsent-reply-send").props.disabled).toBe(false);
    await type(root, "Hi");
    expect(host(root, "send").props.disabled).toBe(false);

    await press(inCard(root, 0, "unsent-reply-pick"));
    const sheet = hosts(root, "unsent-reply")[0]!.find(
      (node) => node.props.testID === "recipient-picker",
    );
    expect(sheet.props.open).toBe(true);
    const list = sheet.find((node) => node.props.testID === "recipient-options");
    expect(String(list.type)).toBe("ScrollView");
    // 20 rows of 52, on a screen 412 tall: the list takes at most half of it, and scrolls.
    expect(list.props.style.maxHeight).toBeLessThanOrEqual(412 / 2);
    const options = list.findAll(
      (node) => typeof node.type === "string" && node.props.testID === "recipient-option",
    );
    expect(options).toHaveLength(20);
    await press(options[19]!);
    expect(cards(root)[0]![0]).toBe("Not sent - to Member 19");
    expect(inCard(root, 0, "unsent-reply-send").props.disabled).toBe(false);
  });

  it("is edited in its card, text and teammate, or discarded with its notification", async () => {
    await keep("e1", "Bok it");
    const root = await open("e1");
    await press(inCard(root, 0, "unsent-reply-edit"));
    await act(async () => inCard(root, 0, "unsent-reply-input").props.onChangeText("Book it"));
    await press(inCard(root, 0, "unsent-reply-to"));
    const options = hosts(root, "recipient-option");
    expect(options).toHaveLength(1);
    await press(options[0]!);
    // Nothing changes until you save, and Cancel leaves it as it was.
    expect(unsentReplies("e1")[0]).toMatchObject({ text: "Bok it", teammateId: "rex" });
    await press(inCard(root, 0, "unsent-reply-save"));
    expect(unsentReplies("e1")[0]).toMatchObject({ text: "Book it", teammateId: "mia" });
    expect(cards(root)).toEqual([["Not sent - to Mia", "Book it"]]);
    await press(inCard(root, 0, "unsent-reply-edit"));
    await act(async () => inCard(root, 0, "unsent-reply-input").props.onChangeText("Nope"));
    await press(inCard(root, 0, "unsent-reply-cancel"));
    expect(cards(root)).toEqual([["Not sent - to Mia", "Book it"]]);
    expect(input(root).props.value).toBe("");

    await press(inCard(root, 0, "unsent-reply-discard"));
    expect(cards(root)).toEqual([]);
    expect(state.cancelNotification).toHaveBeenCalledWith("n:Bok it");
  });

  it("goes to a direct chat's teammate, mentioning nobody", async () => {
    await keep("d1", "Book it", null);
    const root = await open("d1", { isGroup: false, members: [rex] });
    expect(cards(root)).toEqual([["Not sent - to Rex", "Book it"]]);
    await press(inCard(root, 0, "unsent-reply-send"));
    expect(state.send.mock.calls[0]![0]).toMatchObject({ text: "Book it", mentions: [] });
  });
});

/** Each ordering earlier designs got wrong: a send finishing restored or wiped what it didn't own. */
describe("a send from the composer finishing", () => {
  it("keeps your corrections to a card made while it was on its way", async () => {
    await keep("o1", "Bok the room");
    const root = await open("o1");
    await type(root, "Original message");
    const deliver = sendOnItsWay();
    await press(host(root, "send"));
    await press(inCard(root, 0, "unsent-reply-edit"));
    await act(async () =>
      inCard(root, 0, "unsent-reply-input").props.onChangeText("Book the room"),
    );
    await press(inCard(root, 0, "unsent-reply-to"));
    await press(hosts(root, "recipient-option")[0]!);
    await press(inCard(root, 0, "unsent-reply-save"));
    await deliver();
    expect(cards(root)).toEqual([["Not sent - to Mia", "Book the room"]]);
    expect(input(root).props.value).toBe("");
  });

  it("doesn't bring back a card another composer sent meanwhile", async () => {
    const first = await open("o2");
    await type(first, "Original message");
    const deliver = sendOnItsWay();
    await press(host(first, "send"));
    await close(first);
    await keep("o2", "Book the room");
    const second = await open("o2");
    await press(inCard(second, 0, "unsent-reply-send"));
    expect(cards(second)).toEqual([]);
    await deliver();
    expect(cards(second)).toEqual([]);
    expect(unsentReplies("o2")).toEqual([]);
    expect(state.send.mock.calls.map(([sent]) => sent.text)).toEqual([
      "Original message",
      "Book the room",
    ]);
  });

  it("keeps a reply kept after you left the chat", async () => {
    const first = await open("o3");
    await type(first, "Original message");
    const deliver = sendOnItsWay();
    await press(host(first, "send"));
    await close(first);
    await keep("o3", "Book the room");
    await deliver();
    expect(await readDraft("o3")).toBe("");
    const second = await open("o3");
    expect(cards(second)).toEqual([["Not sent - to Rex", "Book the room"]]);
    expect(input(second).props.value).toBe("");
  });
});

describe("dictation", () => {
  it("never touches a reply kept while it starts, or what it's showing", async () => {
    const root = await open("o4");
    let grant!: (value: { granted: boolean }) => void;
    state.permission.mockReturnValueOnce(new Promise((resolve) => (grant = resolve)));
    await press(host(root, "dictate"));
    await keep("o4", "Recovered reply");
    expect(cards(root)).toEqual([["Not sent - to Rex", "Recovered reply"]]);
    await act(async () => grant({ granted: true }));
    await speech("start");
    await speech("result", { isFinal: false, results: [{ transcript: "hello" }] });
    expect(input(root).props.value).toBe("hello");
    expect(cards(root)).toEqual([["Not sent - to Rex", "Recovered reply"]]);
    await speech("end");
  });
});
