/**
 * What the worker sends a phone (FCM data messages, `NativePushData` in @open-bot/domain), and
 * how the app shows it. Platform-free, so it's tested in Node.
 */

import {
  NATIVE_PUSH_TYPES,
  RUN_PROGRESS_STATES,
  type NativePushType,
  type RunProgressState,
} from "@open-bot/domain";

export type ChannelId = "approvals" | "asking" | "messages" | "running" | "connection";

export const CHANNELS: {
  id: ChannelId;
  name: string;
  importance: "high" | "default" | "low";
  /** False: its notifications put no dot on the app's icon. */
  badge?: false;
}[] = [
  { id: "approvals", name: "Approvals", importance: "high" },
  { id: "asking", name: "Teammates asking for you", importance: "high" },
  { id: "messages", name: "Messages and results", importance: "default" },
  // A run in progress is nothing to read: its result, which badges, comes when it ends.
  { id: "running", name: "Running work", importance: "low", badge: false },
  { id: "connection", name: "Phone connection", importance: "low" },
];

export interface PushData {
  type: NativePushType;
  tag: string;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  teammateId?: string;
  chatId?: string;
  runId?: string;
  approvalId?: string;
  approvalNeedsBiometric?: boolean;
  takeoverId?: string;
  /** The page a teammate published; the notification opens it. */
  pageId?: string;
  /** `run-progress` only: where the run is, and the rest its notification shows. */
  runState?: RunProgressState;
  sentAt?: string;
  startedAt?: string;
  stepsDone?: string;
  stepsTotal?: string;
}

/** Reads a data message; anything malformed is null and ignored. */
export function parsePushData(raw: Record<string, unknown> | undefined): PushData | null {
  if (!raw) return null;
  const text = (key: string) =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : undefined;
  const type = text("type");
  const tag = text("tag");
  if (!tag || !type || !(NATIVE_PUSH_TYPES as readonly string[]).includes(type)) return null;
  return {
    type: type as NativePushType,
    tag,
    kind: text("kind"),
    title: text("title"),
    body: text("body"),
    url: text("url"),
    teammateId: text("teammateId"),
    chatId: text("chatId"),
    runId: text("runId"),
    approvalId: text("approvalId"),
    approvalNeedsBiometric: raw.approvalNeedsBiometric === "true",
    takeoverId: text("takeoverId"),
    pageId: text("pageId"),
    ...(type === "run-progress"
      ? {
          runState: RUN_PROGRESS_STATES.find((state) => state === raw.runState),
          sentAt: text("sentAt"),
          startedAt: text("startedAt"),
          stepsDone: text("stepsDone"),
          stepsTotal: text("stepsTotal"),
        }
      : {}),
  };
}

/**
 * A `run-progress` push as the native module reads it (`RunProgress.kt`): every value a string,
 * as FCM delivers it. Null for any other push.
 */
export function runProgressData(data: PushData): Record<string, string> | null {
  if (data.type !== "run-progress") return null;
  const fields = {
    type: data.type,
    tag: data.tag,
    runId: data.runId,
    runState: data.runState,
    sentAt: data.sentAt,
    startedAt: data.startedAt,
    title: data.title,
    body: data.body,
    url: data.url,
    chatId: data.chatId,
    teammateId: data.teammateId,
    stepsDone: data.stepsDone,
    stepsTotal: data.stepsTotal,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * Kinds of notification that are a run's result. Its progress notification goes when one
 * arrives, even before the run's last progress message (`RESULT_KINDS` in the egress module).
 */
const RESULT_KINDS = new Set(["run_finished", "run_failed"]);

/** The run this notification is the result of, or null. */
export function resultRunId(data: PushData): string | null {
  return data.type === "notification" && data.kind && RESULT_KINDS.has(data.kind) && data.runId
    ? data.runId
    : null;
}

export type ActionId = "approve" | "deny" | "review" | "reply" | "take-over" | "type-code";

/**
 * Replies and results you can answer from the notification, with Reply. `bot_message` is what a
 * server from before the database rename (migration 0035) calls `teammate_message`: this build is
 * installed before that deploy. A later build can drop it.
 */
const REPLYABLE_KINDS = new Set(["run_finished", "run_failed", "teammate_message", "bot_message"]); // vocabulary: allow (an older server's kind)

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
  reply?: { chatId: string; teammateId: string };
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
  // Only with the teammate it's from: a reply that mentions nobody goes to a group's lead.
  const reply =
    !isApproval && data.chatId && data.teammateId && data.kind && REPLYABLE_KINDS.has(data.kind)
      ? { chatId: data.chatId, teammateId: data.teammateId }
      : null;
  return {
    id: data.tag,
    channel,
    title: data.title,
    body: data.body ?? "",
    url:
      data.kind === "takeover_request" && data.teammateId
        ? `/screens/${encodeURIComponent(data.teammateId)}${data.takeoverId ? `?takeover=${encodeURIComponent(data.takeoverId)}` : ""}`
        : (data.url ?? "/"),
    actions:
      data.kind === "takeover_request" && data.teammateId && data.takeoverId
        ? [
            { id: "take-over", title: "Take over", opensApp: true },
            { id: "type-code", title: "Type the code", opensApp: true },
          ]
        : !isApproval
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

/**
 * What a replied-to notification says once the reply was sent, or wasn't. Unsent, it shows all
 * you typed: it's the only copy, kept nowhere else.
 */
export function replyText(sent: boolean, text: string): { title: string; body: string } {
  return sent
    ? { title: "Reply sent", body: text }
    : { title: "Your reply wasn't sent", body: text.trim() };
}

/**
 * Where an unsent reply's notification opens: the chat the reply was for, where you can send it,
 * even when the notification was about a page.
 */
export function replyChatUrl(url: string | undefined, chatId: string): string {
  const chat = `/chats/${chatId}`;
  return url === chat || url?.startsWith(`${chat}?`) ? url : chat;
}

/** The start of an unsent reply's notification id. The phone ignores a push tagged with one. */
const UNSENT_REPLY = "unsent-reply:";

/**
 * The id of an unsent reply's notification: its own, so a later push about the same run (which
 * reuses the run's id) can't replace the only copy of what you typed. The same reply failing again
 * replaces its notification; another reply gets its own.
 */
export function unsentReplyId(notificationId: string, text: string): string {
  // FNV-1a over the text's code points.
  let hash = 0x811c9dc5;
  for (const char of text.trim()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${UNSENT_REPLY}${notificationId}:${hash.toString(16).padStart(8, "0")}`;
}

export const isUnsentReplyId = (id: string) => id.startsWith(UNSENT_REPLY);

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
