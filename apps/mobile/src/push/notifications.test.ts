import { beforeEach, describe, expect, it, vi } from "vitest";

const { displayed, cancel, display, send, getApproval, decideApproval, stored } = vi.hoisted(
  () => ({
    /** The phone's AsyncStorage, as the draft store sees it. */
    stored: new Map<string, string>(),
    displayed: vi.fn(),
    cancel: vi.fn(),
    display: vi.fn(),
    send: vi.fn(),
    getApproval: vi.fn(),
    decideApproval: vi.fn(),
  }),
);

vi.mock("@notifee/react-native", () => ({
  default: {
    getDisplayedNotifications: displayed,
    cancelDisplayedNotification: cancel,
    displayNotification: display,
    createChannels: vi.fn(async () => {}),
  },
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
  AndroidCategory: { MESSAGE: "msg" },
  AndroidStyle: { BIGTEXT: 1, MESSAGING: 3 },
  EventType: { ACTION_PRESS: 2 },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("@/lib/api", () => ({
  api: { chats: { send }, approvals: { get: getApproval, decide: decideApproval } },
}));
vi.mock("@/lib/realtime", () => ({ visibleChat: { get: () => null } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: string) => void stored.set(key, value),
  },
}));
// The real draft store, which the app imports through the `@/` alias the tests don't have.
vi.mock("@/features/chat/drafts", () => import("../features/chat/drafts"));
vi.mock("@/theme/colors", () => ({ palette: { light: { foreground: "#14161B" } } }));

import type { Event } from "@notifee/react-native";
import { ORPCError } from "@orpc/client";
import { readDraft, writeDraft } from "../features/chat/drafts";
import { clearChatNotifications, handleNotificationEvent, handlePushData } from "./notifications";

const shown = [
  { id: "reply-a", notification: { data: { chatId: "a" } } },
  { id: "reply-b", notification: { data: { chatId: "b" } } },
  { id: "approval-a", notification: { data: { chatId: "a", approvalId: "approval" } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  // No draft for the chat; keeping one cancels the store's pending debounced write.
  writeDraft("c1", "");
  stored.clear();
  displayed.mockResolvedValue(shown);
  cancel.mockResolvedValue(undefined);
  display.mockResolvedValue(undefined);
  getApproval.mockResolvedValue({ status: "pending" });
  decideApproval.mockResolvedValue({ status: "approved" });
});

describe("native notification rendering and decisions", () => {
  it("renders a replyable message with a native messaging style and free-form RemoteInput", async () => {
    await handlePushData({
      type: "notification",
      tag: "reply",
      kind: "run_finished",
      title: "Rex replied",
      body: "All done",
      chatId: "chat",
      teammateId: "rex",
      url: "/chats/chat",
    });
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        // Kept as it is: notifications shown before an app update carry it and still reply with it.
        data: expect.objectContaining({ replyChatId: "chat", replyBotId: "rex" }), // vocabulary: allow
        android: expect.objectContaining({
          category: "msg",
          style: expect.objectContaining({
            type: 3,
            messages: [expect.objectContaining({ text: "All done" })],
          }),
          actions: [
            expect.objectContaining({
              pressAction: { id: "reply" },
              input: { placeholder: "Reply", allowFreeFormInput: true },
            }),
          ],
        }),
      }),
    );
  });

  const approvalEvent = {
    type: 2,
    detail: {
      pressAction: { id: "approve" },
      notification: {
        id: "approval",
        title: "Approval",
        data: { approvalId: "a1", url: "/approvals/a1" },
      },
    },
  } as unknown as Event;

  it("replaces a stale action with the actual decision from another device", async () => {
    decideApproval.mockRejectedValue(
      new ORPCError("ALREADY_DECIDED", { defined: true, status: 409, data: { status: "denied" } }),
    );
    await handleNotificationEvent(approvalEvent);
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Already denied elsewhere",
        android: expect.objectContaining({ timeoutAfter: 4000 }),
      }),
    );
  });

  it("keeps an unreachable approval action visible and directs the owner to the app", async () => {
    decideApproval.mockRejectedValue(new TypeError("offline"));
    await handleNotificationEvent(approvalEvent);
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't reach open-bot", body: "Open to decide." }),
    );
    expect(display.mock.calls[0]![0].android.timeoutAfter).toBeUndefined();
  });

  it("does not display an approval push that arrived after its decision", async () => {
    getApproval.mockResolvedValue({ status: "denied" });
    await handlePushData({
      type: "notification",
      tag: "late",
      kind: "approval",
      title: "Approve?",
      approvalId: "a1",
    });
    expect(display).not.toHaveBeenCalled();
  });
});

describe("clearing displayed chat notifications", () => {
  it("clears replies for the visible chat and preserves approvals and other chats", async () => {
    await clearChatNotifications("a", () => true);
    expect(cancel.mock.calls).toEqual([["reply-a"]]);
  });

  it("keeps notifications if focus is lost while fetching displayed notifications", async () => {
    let resolve!: (value: typeof shown) => void;
    displayed.mockReturnValue(new Promise((done) => (resolve = done)));
    let visible = true;
    const pending = clearChatNotifications("a", () => visible);
    visible = false;
    resolve(shown);
    await pending;
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("replying from a notification", () => {
  const reply = (input: string) =>
    ({
      type: 2,
      detail: {
        pressAction: { id: "reply" },
        input,
        notification: {
          id: "run-1",
          title: "Rex replied",
          data: { url: "/chats/c1?run=run-1", chatId: "c1", replyChatId: "c1", replyBotId: "b1" }, // vocabulary: allow
        },
      },
    }) as unknown as Event;

  it("sends what you typed to the teammate, then says it was sent", async () => {
    send.mockResolvedValue({ id: "m1" });
    await handleNotificationEvent(reply("Book the 9am one"));
    expect(send).toHaveBeenCalledWith({
      clientId: "11111111-1111-4111-8111-111111111111",
      chatId: "c1",
      text: "Book the 9am one",
      attachments: [],
      mentions: ["b1"],
    });
    expect(display).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        title: "Reply sent",
        body: "Book the 9am one",
        // The confirmation has no Reply of its own.
        data: { url: "/chats/c1?run=run-1", chatId: "c1" },
      }),
    );
  });

  const drafts = () => JSON.parse(stored.get("openbot:drafts") ?? "{}") as Record<string, string>;

  it("leaves the chat's draft alone once the reply is sent", async () => {
    send.mockResolvedValue({ id: "m1" });
    await handleNotificationEvent(reply("Book the 9am one"));
    expect(await readDraft("c1")).toBe("");
    expect(drafts()).not.toHaveProperty("c1");
  });

  it("says so when the reply couldn't be sent, keeps what you typed, and stays until you open it", async () => {
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    const shown = display.mock.calls[0]![0];
    expect(shown).toMatchObject({
      title: "Couldn't send your reply",
      body: "Saved in the chat: “Book it”. Open to send it.",
      data: { url: "/chats/c1?run=run-1", chatId: "c1" },
    });
    expect(shown.android.timeoutAfter).toBeUndefined();
    // Stored before the handler returns: the background task can stop right after.
    expect(drafts()).toEqual({ c1: "Book it" });
    expect(await readDraft("c1")).toBe("Book it");
  });

  it("sends nothing when the notification doesn't say who it's from, and keeps what you typed", async () => {
    // Without a mention a group's lead would answer instead of the teammate who wrote.
    const event = reply("Book it");
    delete (event.detail.notification!.data as Record<string, unknown>).replyBotId; // vocabulary: allow
    await handleNotificationEvent(event);
    expect(send).not.toHaveBeenCalled();
    expect(display.mock.calls[0]![0]).toMatchObject({
      id: "run-1",
      title: "Couldn't send your reply",
      body: "Saved in the chat: “Book it”. Open to send it.",
    });
    // Opening the chat finds it in the composer, which reads this draft.
    expect(drafts()).toEqual({ c1: "Book it" });
    expect(await readDraft("c1")).toBe("Book it");
  });

  it("keeps a draft you'd already started, before the reply that couldn't be sent", async () => {
    writeDraft("c1", "Also, the hotel");
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    expect(drafts().c1).toBe("Also, the hotel\n\nBook it");
  });

  it("sends nothing for an empty reply", async () => {
    await handleNotificationEvent(reply("   "));
    expect(send).not.toHaveBeenCalled();
  });
});
