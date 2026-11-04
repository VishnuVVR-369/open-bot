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
vi.mock("@/components/bot-avatar", () => ({ BotAvatar: "BotAvatar" }));
vi.mock("@/components/sheet", () => ({ Sheet: "Sheet", SheetItem: "SheetItem" }));
vi.mock("@/components/text", () => ({ Text: "Text" }));
vi.mock("@/lib/api", () => ({ api: { chats: { send: state.send } } }));
vi.mock("@/lib/dictation", () => ({
  useDictation: () => ({ listening: false, cancel: state.cancel }),
}));
vi.mock("@/lib/drafts", () => ({ readDraft: async () => "", writeDraft: () => {} }));
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
vi.mock("@/lib/mentions", () => ({ mentionQuery: () => null }));
vi.mock("@/lib/upload-protocol", () => ({ cantAttach: () => null }));
vi.mock("@/lib/uploads", () => ({ uploadAttachment: state.upload }));
vi.mock("@/theme", () => ({
  fonts: { sans: "sans" },
  radius: { xl: 10, lg: 8 },
  space: (value: number) => value,
  useColors: () => ({}),
}));
vi.mock("@/theme/mix", () => ({ mix: () => "black" }));

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
