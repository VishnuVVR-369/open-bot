import notifee, { EventType } from "@notifee/react-native";
import * as Device from "expo-device";
import { router, type Href } from "expo-router";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { queryClient, queryKeys } from "@/lib/query";
import { hasFirebase } from "./firebase";
import { ensureChannels, handleNotificationEvent, handlePushData } from "./notifications";
import { parsePushData } from "./payload";

type MessagingModule = typeof import("@react-native-firebase/messaging");

function messaging(): MessagingModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return hasFirebase ? (require("@react-native-firebase/messaging") as MessagingModule) : null;
}

/**
 * The notification that opened the app stays the "initial" one for as long as the app runs, so
 * remember it was handled: signing out and in again mustn't open it a second time.
 */
const openedInitial = new Set<string>();

function open(url: unknown) {
  if (typeof url === "string" && url.startsWith("/")) router.push(url as Href);
}

async function register(token: string) {
  await api.push.registerDevice({
    token,
    platform: "android",
    device: Device.modelName ?? "Android phone",
  });
}

/**
 * While you're signed in: notification channels and permission, this phone's FCM token on the
 * server, pushes that arrive while the app is open, and taps that open the right screen.
 */
export function usePushNotifications(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    const cleanups: (() => void)[] = [];
    void (async () => {
      await ensureChannels();
      await notifee.requestPermission();
      const initial = await notifee.getInitialNotification();
      const id = initial?.notification.id;
      if (initial && id && !openedInitial.has(id)) {
        openedInitial.add(id);
        open(initial.notification.data?.url);
      }
    })();

    cleanups.push(
      notifee.onForegroundEvent(async (event) => {
        if (event.type === EventType.PRESS) open(event.detail.notification?.data?.url);
        if (event.type === EventType.ACTION_PRESS) {
          if (event.detail.pressAction?.id === "review") open(event.detail.notification?.data?.url);
          else await handleNotificationEvent(event);
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
        }
      }),
    );

    const fcm = messaging();
    if (fcm) {
      const instance = fcm.getMessaging();
      void fcm
        .getToken(instance)
        .then(register)
        .catch((error: unknown) => console.warn("couldn't register for notifications", error));
      cleanups.push(fcm.onTokenRefresh(instance, (token) => void register(token).catch(() => {})));
      cleanups.push(
        fcm.onMessage(instance, async (message) => {
          const data = parsePushData(message.data);
          if (!data) return;
          // A push about something means it changed: refresh what shows it.
          if (data.approvalId)
            void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
          if (data.chatId) void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
          await handlePushData(data);
        }),
      );
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [signedIn]);
}

/** On sign-out: stop notifications to this phone, on the server and in Firebase. */
export async function unregisterPushNotifications(): Promise<void> {
  const fcm = messaging();
  if (!fcm) return;
  const instance = fcm.getMessaging();
  const token = await fcm.getToken(instance).catch(() => null);
  if (token) await api.push.unregisterDevice({ token }).catch(() => {});
  await fcm.deleteToken(instance).catch(() => {});
  await notifee.cancelAllNotifications();
}
