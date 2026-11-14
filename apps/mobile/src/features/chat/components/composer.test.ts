import type { Attachment, MessageView } from "@open-bot/api";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pick: vi.fn(),
  upload: vi.fn(),
  send: vi.fn(),
  onSent: vi.fn(),
  cancel: vi.fn(),
  /** The phone's AsyncStorage, as the draft store sees it. */
  stored: new Map<string, string>(),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: state.pick }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-router", () => ({ useFocusEffect: () => {} }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "AlertCircle",
      "ArrowUp",
      "Camera",
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
vi.mock("@/lib/api", () => ({ api: { chats: { send: state.send } } }));
vi.mock("@/features/chat/dictation", () => ({
  useDictation: () => ({ listening: false, cancel: state.cancel }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => state.stored.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.stored.set(key, value),
  },
}));
// The real draft store and recipients, which the app imports through the `@/` alias.
vi.mock("@/features/chat/drafts", () => import("../drafts"));
vi.mock("@/features/chat/recipients", () => import("../recipients"));
vi.mock("@/features/chat/use-draft", () => import("../use-draft"));
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
// The real attachments hook, which the app imports through the `@/` alias the tests don't have.
vi.mock("@/features/chat/use-attachments", () => import("../use-attachments"));
vi.mock("../uploads", () => ({ uploadAttachment: state.upload }));
vi.mock("@/theme", () => ({
  fonts: { sans: "sans" },
  radius: { xl: 10, lg: 8 },
  space: (value: number) => value,
  useColors: () => ({}),
}));
vi.mock("@/theme/mix", () => ({ mix: () => "black" }));

import type { TeammateSummary } from "@open-bot/api";
import { keepReply, readDraft, writeDraft } from "../drafts";
import { Composer } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer;
const attachment = (id: string): Attachment => ({
  name: `${id}.txt`,
  path: `uploads/${id}`,
  mime: "text/plain",
  size: 1,
});
const button = (id: string) =>
  root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id)[0]!;
async function pick(name: string) {
  state.pick.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: `file://${name}`, name, size: 1, mimeType: "text/plain" }],
  });
  await act(async () => {
    button("attach-files").props.onPress();
  });
}
const chips = () =>
  root.root.findAll((node) => String(node.type) === "View" && node.props.testID === "attachment");

beforeEach(async () => {
  vi.clearAllMocks();
  state.upload.mockResolvedValue({ kind: "complete", attachment: attachment("first") });
  await act(async () => {
    root = create(
      createElement(Composer, {
        chatId: "a",
        placeholder: "Reply",
        members: [],
        isGroup: false,
        activeRun: null,
        onSent: state.onSent,
      }),
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
});

const member = (id: string, name: string) =>
  ({ id, name, color: "#000", emoji: "", role: "Helper" }) as TeammateSummary;
const rex = member("rex", "Rex");
const rexSmith = member("rex-smith", "Rex Smith");
const mia = member("mia", "Mia");
type Chat = { isGroup: boolean; members: TeammateSummary[] };
const composer = (chatId: string, chat: Chat) =>
  createElement(Composer, {
    chatId,
    placeholder: "Reply",
    activeRun: null,
    onSent: state.onSent,
    ...chat,
  });
async function open(chatId: string, chat: Chat) {
  await act(async () => root.unmount());
  await act(async () => {
    root = create(composer(chatId, chat));
  });
}
const input = () => root.root.find((node) => String(node.type) === "TextInput");
const type = (text: string) => act(async () => input().props.onChangeText(text));
const press = (node: ReactTestInstance) => act(async () => void node.props.onPress());
const byTestId = (id: string) =>
  root.root.findAll((node) => typeof node.type === "string" && node.props.testID === id);
/** What each recipient chip says. */
const addressedTo = () =>
  [...byTestId("recipient"), ...byTestId("recipient-missing")].map((chip) =>
    chip
      .findAll((node) => String(node.type) === "Text")
      .map((node) => node.props.children)
      .join(""),
  );
const sent = () => state.send.mock.calls.at(-1)![0];

describe("a saved draft", () => {
  it("is in the composer when you open its chat, from an older build too", async () => {
    state.stored.set("openbot:drafts", JSON.stringify({ old: "Hi there" }));
    // The store read storage when it loaded; this draft is written the way an older build did.
    writeDraft("old", { text: "Hi there", mentions: [] });
    await open("old", { isGroup: true, members: [rex] });
    expect(input().props.value).toBe("Hi there");
  });
});

describe("a reply a notification couldn't send", () => {
  it("goes to the teammate it was for, by id, without writing their name into it", async () => {
    await keepReply("r1", "Book it", "rex");
    // "Rex Smith" contains "Rex": a name in the text would mention both.
    await open("r1", { isGroup: true, members: [rex, rexSmith] });
    expect(input().props.value).toBe("Book it");
    expect(addressedTo()).toEqual(["To Rex"]);
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await press(button("send"));
    expect(sent()).toMatchObject({ text: "Book it", mentions: ["rex"] });
    expect(await readDraft("r1")).toEqual({ text: "", mentions: [] });
  });

  it("goes to the right one of two teammates with the same name, and to one who was renamed", async () => {
    await keepReply("r2", "Book it", "rex-2");
    await open("r2", { isGroup: true, members: [rex, member("rex-2", "Rex")] });
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await press(button("send"));
    expect(sent().mentions).toEqual(["rex-2"]);

    await keepReply("r3", "Book it", "rex");
    await open("r3", { isGroup: true, members: [member("rex", "Rexy")] });
    expect(addressedTo()).toEqual(["To Rexy"]);
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await press(button("send"));
    expect(sent().mentions).toEqual(["rex"]);
  });

  it("can't be sent to a teammate who's no longer in the chat until you pick someone or remove them", async () => {
    await keepReply("r4", "Book it", "gone");
    await open("r4", { isGroup: true, members: [rex, mia] });
    expect(addressedTo()).toEqual(["To a teammate who isn't in this chat"]);
    expect(byTestId("recipient-hint")).toHaveLength(1);
    expect(button("send").props.disabled).toBe(true);
    await press(button("send"));
    expect(state.send).not.toHaveBeenCalled();

    // Pick who it's for instead.
    const missing = byTestId("recipient-missing")[0]!;
    await press(missing.findAll((node) => node.props.accessibilityRole === "button")[0]!);
    const options = byTestId("mention-option");
    expect(options).toHaveLength(2);
    await press(options[1]!);
    expect(addressedTo()).toEqual(["To Mia"]);
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await press(button("send"));
    expect(sent().mentions).toEqual(["mia"]);

    // Or remove them: then it goes to whoever answers the chat, as you chose.
    await keepReply("r5", "Book it", "gone");
    await open("r5", { isGroup: true, members: [rex] });
    await press(byTestId("recipient-remove")[0]!);
    expect(addressedTo()).toEqual([]);
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await press(button("send"));
    expect(sent()).toMatchObject({ text: "Book it", mentions: [] });
  });

  it("blocks a send when the teammate it's for leaves the chat while it's open", async () => {
    await keepReply("r6", "Book it", "rex");
    await open("r6", { isGroup: true, members: [rex, mia] });
    expect(button("send").props.disabled).toBe(false);
    await act(async () => root.update(composer("r6", { isGroup: true, members: [mia] })));
    expect(button("send").props.disabled).toBe(true);
  });
});

describe("a reply kept while its chat is open", () => {
  it("shows up after what you're typing, keeping both, and your next keystroke keeps it", async () => {
    await open("k1", { isGroup: true, members: [rex] });
    await type("Also, the hotel");
    await act(async () => void (await keepReply("k1", "Book it", "rex")));
    expect(input().props.value).toBe("Also, the hotel\n\nBook it");
    expect(addressedTo()).toEqual(["To Rex"]);
    await type("Also, the hotel\n\nBook it!");
    expect(await readDraft("k1")).toEqual({
      text: "Also, the hotel\n\nBook it!",
      mentions: ["rex"],
    });
  });

  it("joins a saved draft the composer hasn't shown yet", async () => {
    writeDraft("k2", { text: "Saved before", mentions: [] });
    await act(async () => root.unmount());
    // Mounted and listening, but its saved draft still on its way from the store.
    act(() => {
      root = create(composer("k2", { isGroup: true, members: [rex] }));
    });
    await act(async () => void (await keepReply("k2", "Book it", "rex")));
    expect(input().props.value).toBe("Saved before\n\nBook it");
    expect(await readDraft("k2")).toEqual({ text: "Saved before\n\nBook it", mentions: ["rex"] });
  });

  it("isn't cleared by a send that was already on its way", async () => {
    await open("k3", { isGroup: true, members: [rex] });
    await type("Hello");
    let deliver!: (message: MessageView) => void;
    state.send.mockReturnValueOnce(new Promise((resolve) => (deliver = resolve)));
    await press(button("send"));
    await act(async () => void (await keepReply("k3", "Book it", "rex")));
    await act(async () => deliver({ id: "sent" } as MessageView));
    expect(sent()).toMatchObject({ text: "Hello", mentions: [] });
    expect(input().props.value).toBe("Book it");
    expect(addressedTo()).toEqual(["To Rex"]);
    expect(await readDraft("k3")).toEqual({ text: "Book it", mentions: ["rex"] });
  });

  it("doesn't reach a composer showing another chat", async () => {
    await open("k4", { isGroup: false, members: [rex] });
    await type("Hi");
    await act(async () => void (await keepReply("k5", "Book it", "rex")));
    expect(input().props.value).toBe("Hi");
  });
});

describe("attachments during a pending send", () => {
  it.each(["uploading", "done", "failed"])(
    "preserves a new %s attachment after the submitted message succeeds",
    async (status) => {
      await pick("first.txt");
      let completeSend!: (message: MessageView) => void;
      state.send.mockReturnValueOnce(
        new Promise((resolve) => {
          completeSend = resolve;
        }),
      );
      await act(async () => {
        button("send").props.onPress();
      });
      expect(state.send.mock.calls[0]![0].attachments).toEqual([attachment("first")]);
      let completeUpload!: (result: unknown) => void;
      state.upload.mockReturnValueOnce(
        new Promise((resolve) => {
          completeUpload = resolve;
        }),
      );
      await pick("second.txt");
      if (status !== "uploading") {
        await act(async () => {
          completeUpload(
            status === "done"
              ? { kind: "complete", attachment: attachment("second") }
              : { kind: "failed", message: "Upload failed" },
          );
        });
      }
      expect(chips()).toHaveLength(2);
      await act(async () => {
        completeSend({ id: "sent" } as MessageView);
      });
      expect(state.onSent).toHaveBeenCalledOnce();
      expect(chips()).toHaveLength(1);
      expect(
        root.root.findAll((node) => node.props.accessibilityLabel === "Remove second.txt"),
      ).toHaveLength(1);
      if (status === "uploading") {
        await act(async () => {
          completeUpload({ kind: "complete", attachment: attachment("second") });
        });
      }
      if (status !== "failed") {
        state.send.mockResolvedValueOnce({ id: "next" } as MessageView);
        await act(async () => {
          button("send").props.onPress();
        });
        expect(state.send.mock.calls.at(-1)![0].attachments).toEqual([attachment("second")]);
        expect(chips()).toHaveLength(0);
      }
    },
  );

  it("preserves submitted and newly selected files after a failed send", async () => {
    await pick("first.txt");
    let fail!: (error: Error) => void;
    state.send.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    await act(async () => {
      button("send").props.onPress();
    });
    state.upload.mockResolvedValueOnce({ kind: "complete", attachment: attachment("second") });
    await pick("second.txt");
    await act(async () => {
      fail(new Error("offline"));
    });
    expect(chips()).toHaveLength(2);
    expect(state.onSent).not.toHaveBeenCalled();
  });
});
