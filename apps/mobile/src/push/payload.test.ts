import { describe, expect, it } from "vitest";
import {
  isOnScreen,
  outcomeText,
  parsePushData,
  planNotification,
  isUnsentReplyId,
  replyChatUrl,
  replyText,
  unsentReplyId,
} from "./payload";

const approval = {
  type: "notification",
  kind: "approval",
  title: "Rex needs your approval",
  body: "Delete the build folder",
  tag: "a1",
  url: "/approvals/a1",
  chatId: "c1",
  approvalId: "a1",
  approvalNeedsBiometric: "false",
};

describe("phone notifications", () => {
  it("opens the page a teammate published, and can still be replied to", () => {
    const data = parsePushData({
      type: "notification",
      kind: "run_finished",
      title: "Iris finished",
      body: "Published “How Kafka works”",
      tag: "r1",
      url: "/pages/p1",
      teammateId: "b1",
      chatId: "c1",
      runId: "r1",
      pageId: "p1",
    })!;
    expect(data.pageId).toBe("p1");
    expect(planNotification(data)).toMatchObject({
      url: "/pages/p1",
      reply: { chatId: "c1", teammateId: "b1" },
    });
  });

  it("opens a screen for takeover actions and keeps code submission in the foreground", () => {
    const asking = planNotification(
      parsePushData({
        type: "notification",
        kind: "takeover_request",
        title: "Rex needs you",
        tag: "t1",
        teammateId: "b1",
        takeoverId: "t1",
      })!,
    );
    expect(asking).toMatchObject({
      channel: "asking",
      url: "/screens/b1?takeover=t1",
      actions: [
        { id: "take-over", title: "Take over", opensApp: true },
        { id: "type-code", title: "Type the code", opensApp: true },
      ],
    });
  });
  it("gives approvals Approve and Deny on the approvals channel", () => {
    const plan = planNotification(parsePushData(approval)!);
    expect(plan).toEqual({
      id: "a1",
      channel: "approvals",
      title: "Rex needs your approval",
      body: "Delete the build folder",
      url: "/approvals/a1",
      approvalId: "a1",
      actions: [
        { id: "approve", title: "Approve", opensApp: false },
        { id: "deny", title: "Deny", opensApp: false },
      ],
    });
  });

  it("makes you open the app to approve a purchase", () => {
    const plan = planNotification(parsePushData({ ...approval, approvalNeedsBiometric: "true" })!);
    expect(plan?.actions).toEqual([{ id: "review", title: "Review", opensApp: true }]);
  });

  it("puts takeover requests and replies on their channels, without buttons", () => {
    const asking = planNotification(
      parsePushData({
        type: "notification",
        kind: "takeover_request",
        title: "Rex needs you",
        tag: "t1",
      })!,
    );
    expect(asking).toMatchObject({ channel: "asking", actions: [], url: "/" });
    const reply = planNotification(
      parsePushData({
        type: "notification",
        kind: "run_finished",
        title: "Rex replied",
        tag: "r1",
      })!,
    );
    expect(reply?.channel).toBe("messages");
    // Without a chat, there's nowhere to reply.
    expect(reply?.actions).toEqual([]);
  });

  it("offers no Reply when it doesn't say which teammate it's from", () => {
    // A reply that mentions nobody goes to a group's lead, not to the teammate who wrote. The
    // older key doesn't count: this build reads only `teammateId`.
    const oldKey = { botId: "b1" }; // vocabulary: allow
    for (const from of [{}, oldKey]) {
      const plan = planNotification(
        parsePushData({
          type: "notification",
          kind: "run_finished",
          title: "Rex replied",
          tag: "r1",
          chatId: "c1",
          url: "/chats/c1?run=r1",
          ...from,
        })!,
      );
      expect(plan?.reply).toBeUndefined();
      expect(plan?.actions).toEqual([]);
      expect(plan?.url).toBe("/chats/c1?run=r1");
    }
  });

  it("lets you reply to a teammate's reply, right from the notification", () => {
    const plan = planNotification(
      parsePushData({
        type: "notification",
        kind: "run_finished",
        title: "Rex replied",
        tag: "r1",
        chatId: "c1",
        teammateId: "b1",
        url: "/chats/c1?run=r1",
      })!,
    );
    expect(plan?.actions).toEqual([
      { id: "reply", title: "Reply", opensApp: false, input: { placeholder: "Reply" } },
    ]);
    expect(plan?.reply).toEqual({ chatId: "c1", teammateId: "b1" });
    const failed = planNotification(
      parsePushData({
        type: "notification",
        kind: "run_failed",
        title: "x",
        tag: "f",
        chatId: "c1",
        teammateId: "b1",
      })!,
    );
    expect(failed?.reply).toEqual({ chatId: "c1", teammateId: "b1" });
    // Approvals and takeovers are decided, not replied to.
    expect(planNotification(parsePushData(approval)!)?.reply).toBeUndefined();
    const asking = planNotification(
      parsePushData({
        type: "notification",
        kind: "takeover_request",
        title: "x",
        tag: "t",
        chatId: "c1",
      })!,
    );
    expect(asking?.actions).toEqual([]);
  });

  it("says what became of a reply from a notification, showing an unsent one in full", () => {
    expect(replyText({ kind: "sent" }, "Book it")).toEqual({
      title: "Reply sent",
      body: "Book it",
    });
    expect(replyText({ kind: "kept", forTeammate: true }, " Book it ")).toEqual({
      title: "Your reply wasn't sent",
      body: "It's in the chat, ready to send: “Book it”",
    });
    // Without the teammate it was for: sent from the chat as it is, a group's lead would get it.
    expect(replyText({ kind: "kept", forTeammate: false }, "Book it")).toEqual({
      title: "Your reply wasn't sent",
      body: "It's in the chat, not addressed to anyone yet: “Book it”",
    });
    const long = "Book the 9am one. ".repeat(20).trim();
    // The phone couldn't store it: no claim it's anywhere, and all of it shows.
    expect(replyText({ kind: "lost" }, ` ${long} `)).toEqual({
      title: "Your reply wasn't sent",
      body: long,
    });
  });

  it("gives an unsent reply a notification id of its own, the same for the same reply", () => {
    const id = unsentReplyId("run-1", "Book it");
    expect(id).not.toBe("run-1");
    expect(isUnsentReplyId(id)).toBe(true);
    expect(isUnsentReplyId("run-1")).toBe(false);
    expect(unsentReplyId("run-1", " Book it\n")).toBe(id);
    expect(unsentReplyId("run-1", "Book it!")).not.toBe(id);
    expect(unsentReplyId("run-2", "Book it")).not.toBe(id);
  });

  it("opens an unsent reply's chat, even from a page's notification", () => {
    expect(replyChatUrl("/chats/c1?run=r1", "c1")).toBe("/chats/c1?run=r1");
    expect(replyChatUrl("/chats/c1", "c1")).toBe("/chats/c1");
    expect(replyChatUrl("/pages/p1", "c1")).toBe("/chats/c1");
    expect(replyChatUrl("/chats/c10", "c1")).toBe("/chats/c1");
    expect(replyChatUrl(undefined, "c1")).toBe("/chats/c1");
  });

  it("ignores malformed messages", () => {
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData({ type: "notification" })).toBeNull();
    expect(parsePushData({ type: "nonsense", tag: "x" })).toBeNull();
    expect(planNotification(parsePushData({ type: "dismiss", tag: "a1" })!)).toBeNull();
  });

  it("stays quiet about the chat on screen, but never about approvals", () => {
    const reply = parsePushData({
      type: "notification",
      kind: "run_finished",
      title: "x",
      tag: "r",
      chatId: "c1",
    })!;
    expect(isOnScreen(reply, "c1", true)).toBe(true);
    expect(isOnScreen(reply, "c1", false)).toBe(false);
    expect(isOnScreen(reply, "c2", true)).toBe(false);
    expect(isOnScreen(parsePushData(approval)!, "c1", true)).toBe(false);
  });

  it("says what happened after a button press", () => {
    expect(outcomeText({ kind: "decided", status: "approved" }).title).toBe("Approved");
    expect(outcomeText({ kind: "already", status: "denied" }).title).toBe(
      "Already denied elsewhere",
    );
    expect(outcomeText({ kind: "already", status: "expired" }).title).toBe(
      "This expired before it was decided",
    );
    expect(outcomeText({ kind: "unreachable" })).toEqual({
      title: "Couldn't reach open-bot",
      body: "Open to decide.",
    });
  });
});
