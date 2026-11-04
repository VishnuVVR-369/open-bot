import { describe, expect, it } from "vitest";
import { isOnScreen, outcomeText, parsePushData, planNotification, replyText } from "./payload";

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
  it("opens a screen for takeover actions and keeps code submission in the foreground", () => {
    const asking = planNotification(
      parsePushData({
        type: "notification",
        kind: "takeover_request",
        title: "Rex needs you",
        tag: "t1",
        botId: "b1",
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

  it("lets you reply to a teammate's reply, right from the notification", () => {
    const plan = planNotification(
      parsePushData({
        type: "notification",
        kind: "run_finished",
        title: "Rex replied",
        tag: "r1",
        chatId: "c1",
        botId: "b1",
        url: "/chats/c1?run=r1",
      })!,
    );
    expect(plan?.actions).toEqual([
      { id: "reply", title: "Reply", opensApp: false, input: { placeholder: "Reply" } },
    ]);
    expect(plan?.reply).toEqual({ chatId: "c1", botId: "b1" });
    const failed = planNotification(
      parsePushData({
        type: "notification",
        kind: "run_failed",
        title: "x",
        tag: "f",
        chatId: "c1",
      })!,
    );
    expect(failed?.reply).toEqual({ chatId: "c1", botId: null });
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

  it("says whether a reply from a notification was sent", () => {
    expect(replyText(true).title).toBe("Reply sent");
    expect(replyText(false)).toEqual({ title: "Couldn't send your reply", body: "Open to reply." });
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
