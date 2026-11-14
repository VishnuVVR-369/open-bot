import type { ApprovalDecision } from "@open-bot/domain";
import notifee, {
  AndroidImportance,
  AndroidCategory,
  AndroidStyle,
  EventType,
  type Event,
  type Notification,
} from "@notifee/react-native";
import { isDefinedError, safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { AppState } from "react-native";
import { keepReply } from "@/features/chat/drafts";
import { api } from "@/lib/api";
import { visibleChat } from "@/lib/realtime";
import { palette } from "@/theme/colors";
import {
  CHANNELS,
  isOnScreen,
  outcomeText,
  planNotification,
  isUnsentReplyId,
  replyChatUrl,
  replyText,
  unsentReplyId,
  type ReplyOutcome,
  type ActionId,
  type DecideOutcome,
  type PushData,
} from "./payload";

const IMPORTANCE = {
  high: AndroidImportance.HIGH,
  default: AndroidImportance.DEFAULT,
  low: AndroidImportance.LOW,
} as const;

/** Notification channels, which you can tune in Android's settings. Safe to call again. */
export async function ensureChannels(): Promise<void> {
  await notifee.createChannels(
    CHANNELS.map((channel) => ({
      id: channel.id,
      name: channel.name,
      importance: IMPORTANCE[channel.importance],
      ...(channel.importance === "low" ? { vibration: false, sound: undefined } : {}),
    })),
  );
}

/** Show (or remove) what a data message from the worker describes. */
export async function handlePushData(data: PushData): Promise<void> {
  // Unsent replies' notifications are the phone's own: no push replaces or removes one.
  if (isUnsentReplyId(data.tag)) return;
  if (data.type === "dismiss") {
    await notifee.cancelNotification(data.tag);
    return;
  }
  const plan = planNotification(data);
  if (!plan) return;
  if (isOnScreen(data, visibleChat.get(), AppState.currentState === "active")) return;
  // A push can arrive late: don't ask about an approval that was already decided.
  if (plan.approvalId) {
    const current = await safe(api.approvals.get({ approvalId: plan.approvalId }));
    if (current.data && current.data.status !== "pending") return;
  }
  await ensureChannels();
  await notifee.displayNotification({
    id: plan.id,
    title: plan.title,
    body: plan.body,
    data: {
      url: plan.url,
      ...(data.takeoverId ? { takeoverId: data.takeoverId } : {}),
      ...(data.teammateId ? { screenId: data.teammateId } : {}),
      ...(data.chatId ? { chatId: data.chatId } : {}),
      ...(plan.approvalId ? { approvalId: plan.approvalId } : {}),
      ...(plan.reply ? { replyChatId: plan.reply.chatId } : {}),
      // A key the phone keeps with each shown notification, so ones shown before an update
      // still reply to their teammate.
      ...(plan.reply ? { replyBotId: plan.reply.teammateId } : {}), // vocabulary: allow
    },
    android: {
      channelId: plan.channel,
      // Its own group per channel: bundled with replies, an approval's buttons are hidden.
      groupId: plan.channel,
      smallIcon: "ic_notification",
      showTimestamp: true,
      color: palette.light.foreground,
      category: plan.reply ? AndroidCategory.MESSAGE : undefined,
      style: plan.reply
        ? {
            type: AndroidStyle.MESSAGING,
            person: { name: "You" },
            title: plan.title,
            messages: [
              {
                text: plan.body,
                timestamp: Date.now(),
                person: { name: plan.title, id: data.teammateId, bot: true }, // vocabulary: allow (Notifee's)
              },
            ],
          }
        : plan.body
          ? { type: AndroidStyle.BIGTEXT, text: plan.body }
          : undefined,
      pressAction: { id: "default", launchActivity: "default" },
      actions: plan.actions.map((action) => ({
        title: action.title,
        pressAction: action.opensApp
          ? { id: action.id, launchActivity: "default" }
          : { id: action.id },
        ...(action.input
          ? { input: { placeholder: action.input.placeholder, allowFreeFormInput: true } }
          : {}),
      })),
    },
  });
}

/**
 * Clear what was said in a chat once you're looking at it. Approvals stay: they still need you.
 * So does a reply the phone couldn't send or store: its notification is the only copy of it.
 */
export async function clearChatNotifications(
  chatId: string,
  isVisible: () => boolean,
): Promise<void> {
  const shown = await notifee.getDisplayedNotifications();
  if (!isVisible()) return;
  await Promise.all(
    shown
      .filter(({ id, notification }) => id && notification.data?.chatId === chatId)
      .filter(({ notification }) => !notification.data?.approvalId)
      .filter(({ notification }) => notification.data?.unsentReply !== "true")
      .map(({ id }) => notifee.cancelDisplayedNotification(id!)),
  );
}

async function decide(approvalId: string, decision: ApprovalDecision): Promise<DecideOutcome> {
  const result = await safe(api.approvals.decide({ approvalId, decision, alwaysAllow: null }));
  if (!result.error) return { kind: "decided", status: decision };
  if (isDefinedError(result.error) && result.error.code === "ALREADY_DECIDED")
    return {
      kind: "already",
      status: result.error.data.status as "approved" | "denied" | "expired",
    };
  return { kind: "unreachable" };
}

/** Send what was typed into a notification's Reply, to the teammate the notification is from. */
async function sendReply(notification: Notification, text: string): Promise<void> {
  const chatId = notification.data?.replyChatId;
  const teammateId = notification.data?.replyBotId; // vocabulary: allow (a stored key)
  // Nothing typed: the notification stays as it was.
  if (!notification.id || typeof chatId !== "string" || !text.trim()) return;
  // Without its teammate the reply would mention nobody, and a group's lead would get it instead:
  // it isn't sent.
  const result =
    typeof teammateId === "string" && teammateId
      ? await safe(
          api.chats.send({
            clientId: Crypto.randomUUID(),
            chatId,
            text,
            attachments: [],
            mentions: [teammateId],
          }),
        )
      : { error: new Error("The notification doesn't say who it's from.") };
  const forTeammate = typeof teammateId === "string" && teammateId !== "";
  // Unsent, it waits in the chat's composer, for its teammate, so opening the chat doesn't mean
  // typing it again. When the phone can't store it, this notification keeps it.
  const kept: ReplyOutcome = !result.error
    ? { kind: "sent" }
    : (await keepReply(chatId, text, forTeammate ? teammateId : null))
      ? { kind: "kept", forTeammate }
      : { kind: "lost" };
  const sent = kept.kind === "sent";
  const outcome = replyText(kept, text);
  const url = typeof notification.data?.url === "string" ? notification.data.url : undefined;
  await notifee.displayNotification({
    // Sent, it replaces the notification replied to. Unsent, it's a notification of its own (and
    // the one replied to goes): a later push about the same run reuses that one's id.
    id: sent ? notification.id : unsentReplyId(notification.id, text),
    title: outcome.title,
    body: outcome.body,
    // Without the reply fields: this one is about the reply, so it has no Reply of its own.
    // Unsent, it opens that chat (not a page the notification was about), where the reply waits.
    // If the phone couldn't store it, it shows all you typed until you dismiss it, even once you
    // open the chat.
    data: sent
      ? { url: url ?? "/", chatId }
      : {
          url: replyChatUrl(url, chatId),
          chatId,
          ...(kept.kind === "lost" ? { unsentReply: "true" } : {}),
        },
    android: {
      channelId: "messages",
      groupId: "messages",
      smallIcon: "ic_notification",
      showTimestamp: true,
      color: palette.light.foreground,
      pressAction: { id: "default", launchActivity: "default" },
      onlyAlertOnce: true,
      ...(sent
        ? { timeoutAfter: 4_000 }
        : {
            style: { type: AndroidStyle.BIGTEXT, text: outcome.body },
            ...(kept.kind === "lost" ? { autoCancel: false } : {}),
          }),
    },
  });
  if (!sent) await notifee.cancelNotification(notification.id);
}

/**
 * A button on a notification was pressed. Approve and Deny decide right here, without opening
 * the app, and Reply sends what you typed; then the notification says how it went.
 */
export async function handleNotificationEvent({ type, detail }: Event): Promise<void> {
  if (type !== EventType.ACTION_PRESS) return;
  const action = detail.pressAction?.id as ActionId | undefined;
  const notification = detail.notification;
  if (action === "reply" && notification) {
    await sendReply(notification, detail.input ?? "");
    return;
  }
  const approvalId = notification?.data?.approvalId;
  if (!notification?.id || typeof approvalId !== "string") return;
  if (action !== "approve" && action !== "deny") return;
  const outcome = await decide(approvalId, action === "approve" ? "approved" : "denied");
  const text = outcomeText(outcome);
  const unreachable = outcome.kind === "unreachable";
  const replacement: Notification = {
    id: notification.id,
    title: text.title,
    body: unreachable ? text.body : notification.title,
    data: notification.data,
    android: {
      channelId: "approvals",
      groupId: "approvals",
      smallIcon: "ic_notification",
      showTimestamp: true,
      color: palette.light.foreground,
      pressAction: { id: "default", launchActivity: "default" },
      onlyAlertOnce: true,
      // A decision only needs a moment's confirmation; a failure stays until you open it.
      ...(unreachable ? {} : { timeoutAfter: 4_000 }),
    },
  };
  await notifee.displayNotification(replacement);
}
