import type { Attachment, MessageView } from "@open-bot/api";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
// The real draft store, which the app imports through the `@/` alias the tests don't have.
vi.mock("@/features/chat/drafts", () => import("../drafts"));
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
import { keepDraft, readDraft, writeDraft } from "../drafts";
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
  state.stored.clear();
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

const rex = { id: "rex", name: "Rex" } as TeammateSummary;
const input = () => root.root.find((node) => String(node.type) === "TextInput");
const type = async (text: string) => {
  await act(async () => input().props.onChangeText(text));
};
async function open(chatId: string, props: { isGroup: boolean; members: TeammateSummary[] }) {
  await act(async () => root.unmount());
  await act(async () => {
    root = create(composer(chatId, props));
  });
}
const composer = (chatId: string, props: { isGroup: boolean; members: TeammateSummary[] }) =>
  createElement(Composer, {
    chatId,
    placeholder: "Reply",
    activeRun: null,
    onSent: state.onSent,
    ...props,
  });

describe("a saved draft", () => {
  it("is in the composer when you open its chat", async () => {
    writeDraft("d1", "Book it");
    await open("d1", { isGroup: true, members: [rex] });
    expect(input().props.value).toBe("Book it");
  });

  it("names the teammate a reply a notification couldn't send was to, so it goes to them", async () => {
    await keepDraft("d2", "Book it", "rex");
    await open("d2", { isGroup: true, members: [rex] });
    expect(input().props.value).toBe("@Rex Book it");
    state.send.mockResolvedValueOnce({ id: "sent" } as MessageView);
    await act(async () => button("send").props.onPress());
    // Without the mention the group's lead would answer it.
    expect(state.send.mock.calls[0]![0]).toMatchObject({ text: "@Rex Book it", mentions: ["rex"] });
    expect(await readDraft("d2")).toEqual({ text: "", mentions: [] });
  });

  it("names them once the chat's members arrive", async () => {
    await keepDraft("d3", "Book it", "rex");
    await open("d3", { isGroup: true, members: [] });
    expect(input().props.value).toBe("Book it");
    await act(async () => root.update(composer("d3", { isGroup: true, members: [rex] })));
    expect(input().props.value).toBe("@Rex Book it");
  });
});

describe("a reply kept while its chat is open", () => {
  it("shows up in the composer, and what you type next doesn't write over it", async () => {
    await open("k1", { isGroup: true, members: [rex] });
    await act(async () => void (await keepDraft("k1", "Book it", "rex")));
    expect(input().props.value).toBe("@Rex Book it");
    await type("@Rex Book it, the 9am one");
    expect((await readDraft("k1")).text).toBe("@Rex Book it, the 9am one");
  });

  it("goes after what you're typing, keeping both", async () => {
    await open("k2", { isGroup: false, members: [rex] });
    await type("Also, the hotel");
    await act(async () => void (await keepDraft("k2", "Book it", "rex")));
    expect(input().props.value).toBe("Also, the hotel\n\nBook it");
    await type("Also, the hotel\n\nBook it!");
    expect((await readDraft("k2")).text).toBe("Also, the hotel\n\nBook it!");
  });

  it("doesn't reach a composer showing another chat", async () => {
    await open("k3", { isGroup: false, members: [rex] });
    await type("Hi");
    await act(async () => void (await keepDraft("k4", "Book it", "rex")));
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
