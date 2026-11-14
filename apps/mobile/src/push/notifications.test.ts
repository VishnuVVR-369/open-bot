import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  displayed,
  cancel,
  cancelById,
  display,
  send,
  getApproval,
  decideApproval,
  tray,
  stored,
  storage,
} = vi.hoisted(() => ({
  /** What's shown, by notification id, as Notifee keeps it: showing an id again replaces it. */
  tray: new Map<string, { id: string; title?: string; body?: string }>(),
  /** The phone's AsyncStorage, as the draft store sees it. */
  stored: new Map<string, string>(),
  storage: { failing: false },
  displayed: vi.fn(),
  cancel: vi.fn(),
  cancelById: vi.fn(),
  display: vi.fn(),
  send: vi.fn(),
  getApproval: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("@notifee/react-native", () => ({
  default: {
    getDisplayedNotifications: displayed,
    cancelDisplayedNotification: cancel,
    cancelNotification: cancelById,
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
    setItem: async (key: string, value: string) => {
      if (storage.failing) throw new Error("disk full");
      stored.set(key, value);
    },
  },
}));
// The real draft store, which the app imports through the `@/` alias the tests don't have.
vi.mock("@/features/chat/drafts", () => import("../features/chat/drafts"));
vi.mock("@/theme/colors", () => ({ palette: { light: { foreground: "#14161B" } } }));

import type { Event } from "@notifee/react-native";
import { ORPCError } from "@orpc/client";
import { readDraft, writeDraft } from "../features/chat/drafts";
import { clearChatNotifications, handleNotificationEvent, handlePushData } from "./notifications";
import { unsentReplyId } from "./payload";

const shown = [
  { id: "reply-a", notification: { data: { chatId: "a" } } },
  { id: "reply-b", notification: { data: { chatId: "b" } } },
  { id: "approval-a", notification: { data: { chatId: "a", approvalId: "approval" } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  // No draft for the chat (and no pending write of one), and storage that works.
  writeDraft("c1", { text: "", mentions: [] });
  stored.clear();
  storage.failing = false;
  displayed.mockResolvedValue(shown);
  cancel.mockResolvedValue(undefined);
  tray.clear();
  display.mockImplementation(async (notification: { id: string }) => {
    tray.set(notification.id, notification);
  });
  cancelById.mockImplementation(async (id: string) => {
    tray.delete(id);
  });
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

  it("keeps an unsent reply: its notification is the only copy of what you typed", async () => {
    displayed.mockResolvedValue([
      ...shown,
      { id: "unsent-a", notification: { data: { chatId: "a", unsentReply: "true" } } },
    ]);
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

  const drafts = () => JSON.parse(stored.get("openbot:drafts") ?? "{}") as Record<string, unknown>;

  it("leaves the chat's draft alone once the reply is sent", async () => {
    send.mockResolvedValue({ id: "m1" });
    await handleNotificationEvent(reply("Book the 9am one"));
    expect(drafts()).not.toHaveProperty("c1");
  });

  /** The notification a reply kept in the chat leaves: it opens the chat, where the reply waits. */
  const kept = (body: string, url = "/chats/c1?run=run-1", text = "Book it") => ({
    id: unsentReplyId("run-1", text),
    title: "Your reply wasn't sent",
    body,
    data: { url, chatId: "c1" },
    android: expect.objectContaining({ style: { type: 1, text: body } }),
  });

  it("keeps a reply that couldn't be sent in the chat, for the teammate it was to", async () => {
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    const shown = display.mock.calls[0]![0];
    expect(shown).toMatchObject(kept("It's in the chat, ready to send: “Book it”"));
    expect(shown.android.timeoutAfter).toBeUndefined();
    // Stored before the handler returns (the background task can stop right after), addressed by
    // id: the text stays as typed, with no `@Name` that could match someone else.
    expect(drafts()).toEqual({ c1: { text: "Book it", mentions: ["b1"] } });
  });

  it("keeps a draft you'd already started, with the reply after it", async () => {
    writeDraft("c1", { text: "Also, the hotel", mentions: [] });
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    expect(drafts().c1).toEqual({ text: "Also, the hotel\n\nBook it", mentions: ["b1"] });
  });

  it("keeps a reply to a page's notification in the page's chat, and opens that chat", async () => {
    send.mockRejectedValue(new Error("offline"));
    const event = reply("Book it");
    event.detail.notification!.data!.url = "/pages/p1";
    await handleNotificationEvent(event);
    expect(display.mock.calls[0]![0]).toMatchObject(
      kept("It's in the chat, ready to send: “Book it”", "/chats/c1"),
    );
    expect(await readDraft("c1")).toEqual({ text: "Book it", mentions: ["b1"] });
  });

  it("sends nothing when the notification doesn't say who it's from, and keeps it addressed to no one", async () => {
    // Without a mention a group's lead would answer instead of the teammate who wrote.
    const event = reply("Book it");
    delete (event.detail.notification!.data as Record<string, unknown>).replyBotId; // vocabulary: allow
    await handleNotificationEvent(event);
    expect(send).not.toHaveBeenCalled();
    expect(display.mock.calls[0]![0]).toMatchObject(
      kept("It's in the chat, not addressed to anyone yet: “Book it”"),
    );
    expect(drafts()).toEqual({ c1: "Book it" });
  });

  it("shows all of a reply the phone couldn't store either, until you dismiss it", async () => {
    storage.failing = true;
    send.mockRejectedValue(new Error("offline"));
    const long = "Book the 9am one, and the hotel near the venue. ".repeat(8).trim();
    await handleNotificationEvent(reply(long));
    const shown = display.mock.calls[0]![0];
    expect(shown).toMatchObject({
      id: unsentReplyId("run-1", long),
      title: "Your reply wasn't sent",
      body: long,
      // Marked, so opening the chat doesn't clear it.
      data: { url: "/chats/c1?run=run-1", chatId: "c1", unsentReply: "true" },
      android: expect.objectContaining({ autoCancel: false, style: { type: 1, text: long } }),
    });
    expect(JSON.stringify(shown)).not.toMatch(/saved|in the chat/i);
  });

  it("keeps an unsent reply when a later push about the same run arrives, or is dismissed", async () => {
    // Replied offline to a message while its run went on, on a phone that can't store it either:
    // the notification is its only copy.
    storage.failing = true;
    tray.set("run-1", { id: "run-1", title: "Rex" });
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    const kept = [...tray.values()].find((shown) => shown.title === "Your reply wasn't sent")!;
    expect(kept.id).not.toBe("run-1");
    // The notification replied to goes; the reply has a notification of its own.
    expect([...tray.keys()]).toEqual([kept.id]);

    // The run finishes: its push reuses the run's id.
    await handlePushData({
      type: "notification",
      tag: "run-1",
      kind: "run_finished",
      title: "Rex finished",
      body: "Done",
      chatId: "c1",
      teammateId: "b1",
      url: "/chats/c1?run=run-1",
    });
    await handlePushData({ type: "dismiss", tag: "run-1" });
    expect(tray.get(kept.id)).toMatchObject({ body: "Book it" });

    // No push can reach it, even one with its id.
    await handlePushData({ type: "dismiss", tag: kept.id });
    await handlePushData({ type: "notification", tag: kept.id, kind: "run_finished", title: "x" });
    expect(tray.get(kept.id)).toMatchObject({ title: "Your reply wasn't sent", body: "Book it" });
  });

  it("shows the same reply failing again once, and each different reply", async () => {
    storage.failing = true;
    send.mockRejectedValue(new Error("offline"));
    await handleNotificationEvent(reply("Book it"));
    await handleNotificationEvent(reply("Book it "));
    expect(tray.size).toBe(1);
    await handleNotificationEvent(reply("Book the 9am one"));
    expect([...tray.values()].map((shown) => shown.body).sort()).toEqual([
      "Book it",
      "Book the 9am one",
    ]);
  });

  it("sends nothing for an empty reply", async () => {
    await handleNotificationEvent(reply("   "));
    expect(send).not.toHaveBeenCalled();
  });
});
