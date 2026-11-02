import notifee, {
  AndroidImportance,
  AndroidStyle,
  EventType,
  type Event,
  type Notification,
} from "@notifee/react-native";
import { isDefinedError, safe } from "@orpc/client";
import { AppState } from "react-native";
import { api } from "@/lib/api";
import { visibleChat } from "@/lib/realtime";
import { palette } from "@/theme/colors";
import {
  CHANNELS,
  isOnScreen,
  outcomeText,
  planNotification,
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
      ...(data.chatId ? { chatId: data.chatId } : {}),
      ...(plan.approvalId ? { approvalId: plan.approvalId } : {}),
    },
    android: {
      channelId: plan.channel,
      // Its own group per channel: bundled with replies, an approval's buttons are hidden.
      groupId: plan.channel,
      smallIcon: "ic_notification",
      showTimestamp: true,
      color: palette.light.foreground,
      style: plan.body ? { type: AndroidStyle.BIGTEXT, text: plan.body } : undefined,
      pressAction: { id: "default", launchActivity: "default" },
      actions: plan.actions.map((action) => ({
        title: action.title,
        pressAction: action.opensApp
          ? { id: action.id, launchActivity: "default" }
          : { id: action.id },
      })),
    },
  });
}

/**
 * Clear what was said in a chat once you're looking at it. Approvals stay: they still need you.
 */
export async function clearChatNotifications(chatId: string): Promise<void> {
  const shown = await notifee.getDisplayedNotifications();
  await Promise.all(
    shown
      .filter(({ id, notification }) => id && notification.data?.chatId === chatId)
      .filter(({ notification }) => !notification.data?.approvalId)
      .map(({ id }) => notifee.cancelDisplayedNotification(id!)),
  );
}

async function decide(approvalId: string, decision: "approved" | "denied"): Promise<DecideOutcome> {
  const result = await safe(api.approvals.decide({ approvalId, decision, alwaysAllow: null }));
  if (!result.error) return { kind: "decided", status: decision };
  if (isDefinedError(result.error) && result.error.code === "ALREADY_DECIDED")
    return {
      kind: "already",
      status: result.error.data.status as "approved" | "denied" | "expired",
    };
  return { kind: "unreachable" };
}

/**
 * A button on a notification was pressed. Approve and Deny decide right here, without opening
 * the app, then the notification says how it went.
 */
export async function handleNotificationEvent({ type, detail }: Event): Promise<void> {
  if (type !== EventType.ACTION_PRESS) return;
  const action = detail.pressAction?.id as ActionId | undefined;
  const notification = detail.notification;
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
