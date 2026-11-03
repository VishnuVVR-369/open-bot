/**
 * What the worker sends a phone (FCM data messages, see apps/worker/src/services/fcm.ts), and
 * how the app shows it. Platform-free, so it's tested in Node.
 */

export type ChannelId = "approvals" | "asking" | "messages" | "running" | "connection";

export const CHANNELS: { id: ChannelId; name: string; importance: "high" | "default" | "low" }[] = [
  { id: "approvals", name: "Approvals", importance: "high" },
  { id: "asking", name: "Teammates asking for you", importance: "high" },
  { id: "messages", name: "Messages and results", importance: "default" },
  { id: "running", name: "Running work", importance: "low" },
  { id: "connection", name: "Phone connection", importance: "low" },
];

export interface PushData {
  type: "notification" | "dismiss" | "egress-needed" | "run-progress";
  tag: string;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  botId?: string;
  chatId?: string;
  runId?: string;
  approvalId?: string;
  approvalNeedsBiometric?: boolean;
  takeoverId?: string;
}

/** Reads a data message; anything malformed is null and ignored. */
export function parsePushData(raw: Record<string, unknown> | undefined): PushData | null {
  if (!raw) return null;
  const text = (key: string) =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : undefined;
  const type = text("type");
  const tag = text("tag");
  if (!tag || !type || !["notification", "dismiss", "egress-needed", "run-progress"].includes(type))
    return null;
  return {
    type: type as PushData["type"],
    tag,
    kind: text("kind"),
    title: text("title"),
    body: text("body"),
    url: text("url"),
    botId: text("botId"),
    chatId: text("chatId"),
    runId: text("runId"),
    approvalId: text("approvalId"),
    approvalNeedsBiometric: raw.approvalNeedsBiometric === "true",
    takeoverId: text("takeoverId"),
  };
}

export type ActionId = "approve" | "deny" | "review" | "reply";

/** Replies and results you can answer from the notification, with Reply. */
const REPLYABLE_KINDS = new Set(["run_finished", "run_failed", "bot_message"]);

export interface NotificationPlan {
  /** Replaces any notification with the same id. */
  id: string;
  channel: ChannelId;
  title: string;
  body: string;
  /** Where tapping it goes, in the app. */
  url: string;
  /**
   * Buttons. Approve, Deny and Reply work without opening the app; Review opens it. Reply takes
   * what you type right in the notification.
   */
  actions: { id: ActionId; title: string; opensApp: boolean; input?: { placeholder: string } }[];
  approvalId?: string;
  /** Where a Reply goes, and who it's for (they're mentioned, so in a group they get it). */
  reply?: { chatId: string; botId: string | null };
}

/**
 * How a notification looks. Approvals get Approve and Deny, except ones that need your
 * fingerprint (purchases), which only get Review: those are approved in the app.
 */
export function planNotification(data: PushData): NotificationPlan | null {
  if (data.type !== "notification" || !data.title) return null;
  const isApproval = data.kind === "approval" && Boolean(data.approvalId);
  const channel: ChannelId = isApproval
    ? "approvals"
    : data.kind === "takeover_request"
      ? "asking"
      : "messages";
  const reply =
    !isApproval && data.chatId && data.kind && REPLYABLE_KINDS.has(data.kind)
      ? { chatId: data.chatId, botId: data.botId ?? null }
      : null;
  return {
    id: data.tag,
    channel,
    title: data.title,
    body: data.body ?? "",
    url: data.url ?? "/",
    actions: !isApproval
      ? reply
        ? [{ id: "reply", title: "Reply", opensApp: false, input: { placeholder: "Reply" } }]
        : []
      : data.approvalNeedsBiometric
        ? [{ id: "review", title: "Review", opensApp: true }]
        : [
            { id: "approve", title: "Approve", opensApp: false },
            { id: "deny", title: "Deny", opensApp: false },
          ],
    ...(isApproval ? { approvalId: data.approvalId } : {}),
    ...(reply ? { reply } : {}),
  };
}

/** What a replied-to notification says once the reply was sent, or wasn't. */
export function replyText(sent: boolean): { title: string; body: string } {
  return sent
    ? { title: "Reply sent", body: "" }
    : { title: "Couldn't send your reply", body: "Open to reply." };
}

/** Don't show a notification about the chat you're looking at; it's on screen already. */
export function isOnScreen(data: PushData, visibleChatId: string | null, appActive: boolean) {
  return appActive && data.kind !== "approval" && !!data.chatId && data.chatId === visibleChatId;
}

export type DecideOutcome =
  | { kind: "decided"; status: "approved" | "denied" }
  | { kind: "already"; status: "approved" | "denied" | "expired" }
  | { kind: "unreachable" };

/** What the notification says after a button press, so you know it worked. */
export function outcomeText(outcome: DecideOutcome): { title: string; body: string } {
  switch (outcome.kind) {
    case "decided":
      return { title: outcome.status === "approved" ? "Approved" : "Denied", body: "" };
    case "already":
      return {
        title:
          outcome.status === "expired"
            ? "This expired before it was decided"
            : `Already ${outcome.status} elsewhere`,
        body: "",
      };
    case "unreachable":
      return { title: "Couldn't reach open-bot", body: "Open to decide." };
  }
}
