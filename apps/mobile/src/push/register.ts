import notifee, { EventType } from "@notifee/react-native";
import * as Device from "expo-device";
import { router, type Href } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { api } from "@/lib/api";
import { keysForPush, queryClient, queryKeys } from "@/lib/query";
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
const notificationKey = (id: string, url: unknown) => JSON.stringify([id, url]);

function open(url: unknown) {
  if (typeof url === "string" && url.startsWith("/")) router.push(url as Href);
}

function actionUrl(url: unknown, action: unknown): unknown {
  return action === "type-code" && typeof url === "string" && url.startsWith("/screens/")
    ? `${url}${url.includes("?") ? "&" : "?"}code=1`
    : url;
}

async function openInitialNotification() {
  const initial = await notifee.getInitialNotification();
  const id = initial?.notification.id;
  const url = actionUrl(initial?.notification.data?.url, initial?.pressAction?.id);
  const key = id ? notificationKey(id, url) : null;
  if (initial && key && !openedInitial.has(key)) {
    openedInitial.add(key);
    open(url);
  }
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
      await openInitialNotification();
    })();

    // A Review/body press can launch an already mounted app. Its background event does not
    // reach onForegroundEvent, so consume the Android launch intent on resume as well.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void openInitialNotification();
    });
    cleanups.push(() => appState.remove());

    cleanups.push(
      notifee.onForegroundEvent(async (event) => {
        if (event.type === EventType.PRESS) {
          if (event.detail.notification?.id)
            openedInitial.add(
              notificationKey(event.detail.notification.id, event.detail.notification.data?.url),
            );
          open(event.detail.notification?.data?.url);
        }
        if (event.type === EventType.ACTION_PRESS) {
          if (["review", "take-over", "type-code"].includes(event.detail.pressAction?.id ?? "")) {
            if (event.detail.notification?.id)
              openedInitial.add(
                notificationKey(event.detail.notification.id, event.detail.notification.data?.url),
              );
            open(actionUrl(event.detail.notification?.data?.url, event.detail.pressAction?.id));
          } else await handleNotificationEvent(event);
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
          void queryClient.invalidateQueries({ queryKey: queryKeys.home });
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
          for (const queryKey of keysForPush(data))
            void queryClient.invalidateQueries({ queryKey });
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
