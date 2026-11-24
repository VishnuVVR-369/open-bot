import notifee, { EventType } from "@notifee/react-native";
import * as Device from "expo-device";
import * as Network from "expo-network";
import { router, type Href } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { api } from "@/lib/api";
import { signOutsSettled } from "@/lib/phone-egress";
import { keysForPush, queryClient, queryKeys } from "@/lib/query";
import { visibleChat } from "@/lib/realtime";
import RunProgress from "../../modules/run-progress";
import { messaging } from "./firebase";
import { ensureChannels, handleNotificationEvent, handlePushData } from "./notifications";
import { parsePushData } from "./payload";
import { PushRegistrar } from "./registrar";

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

/** Registers the token with this sign-in's registration; returns the registration the server stored. */
async function register(token: string, registration: string): Promise<string | undefined> {
  const stored = await api.push.registerDevice({
    token,
    platform: "android",
    device: Device.modelName ?? "Android phone",
    registration,
  });
  return stored.registration;
}

/**
 * While you're signed in (`sessionId`, your session's id; null when signed out): notification
 * channels and permission, this phone's FCM token on the server with this sign-in's registration,
 * pushes that arrive while the app is open, and taps that open the right screen.
 *
 * The token is registered when you sign in or the app starts, and checked again whenever the app
 * comes back to the screen or back online, or Firebase gives it a new one (`PushRegistrar`): a
 * registration that failed is tried again with backoff, and stops when you sign out.
 */
export function usePushNotifications(sessionId: string | null) {
  useEffect(() => {
    if (!sessionId) return;
    const cleanups: (() => void)[] = [];
    let registrar: PushRegistrar | null = null;
    let ended = false;
    // First: after sign-out nothing registers this sign-in again, and a reply that comes later
    // changes nothing.
    cleanups.push(() => {
      ended = true;
      registrar?.stop();
    });
    const fcm = messaging();
    // A sign-out still tearing down the sign-in before (its session ended, and you signed in
    // again at once) finishes first: it forgets the registration and deletes the token.
    void signOutsSettled().then(() => {
      if (ended) return;
      // This sign-in, which every push to this phone carries: one per session, so a new sign-in
      // never uses the registration of one before it, even one this phone never saw end. Taken
      // before the token is registered, so no push can carry it before the phone has it.
      const registration = RunProgress.registration(sessionId);
      if (!fcm) return;
      registrar = new PushRegistrar({
        registration,
        token: () => fcm.getToken(fcm.getMessaging()),
        register,
        onError: (error) => console.warn("couldn't register for notifications", error),
      });
      registrar.sync();
    });
    // A run's progress notification goes while its chat is on screen, where the run shows anyway.
    RunProgress.setVisibleChat(visibleChat.get());
    cleanups.push(visibleChat.subscribe((chatId) => RunProgress.setVisibleChat(chatId)));
    void (async () => {
      await ensureChannels();
      await notifee.requestPermission();
      await openInitialNotification();
    })();

    // A Review/body press can launch an already mounted app. Its background event does not
    // reach onForegroundEvent, so consume the Android launch intent on resume as well.
    // Back on screen, the token is checked too: it may have changed while the app wasn't running.
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void openInitialNotification();
      registrar?.sync();
    });
    cleanups.push(() => appState.remove());
    // Back online: a registration that failed offline goes now, with a fresh set of tries. The
    // listener reports only changes, so an app started offline learns that from the state now,
    // unless a change came first.
    let online: boolean | null = null;
    const reachable = ({ isConnected, isInternetReachable }: Network.NetworkState) =>
      isConnected !== false && isInternetReachable !== false;
    const network = Network.addNetworkStateListener((state) => {
      const now = reachable(state);
      if (now && online === false) registrar?.sync();
      online = now;
    });
    cleanups.push(() => network.remove());
    void Network.getNetworkStateAsync()
      .then((state) => {
        if (online === null) online = reachable(state);
      })
      .catch(() => {});

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

    if (fcm) {
      const instance = fcm.getMessaging();
      cleanups.push(fcm.onTokenRefresh(instance, () => registrar?.sync()));
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
  }, [sessionId]);
}

/** This phone's FCM token, for waking its phone connection; null without Firebase. */
export async function currentPushToken(): Promise<string | null> {
  const fcm = messaging();
  if (!fcm) return null;
  return fcm.getToken(fcm.getMessaging()).catch(() => null);
}

/** Whether this phone holds a sign-in: it registered for pushes, and hasn't signed out since. */
export function holdsSignIn(): boolean {
  return RunProgress.signedIn();
}

/**
 * The first step of a sign-out: every progress notification goes, with the registration their
 * pushes must carry, so nothing for the account you left draws again, even a push on its way.
 */
export function forgetRunProgress(): void {
  RunProgress.reset();
}

/**
 * On sign-out: run progress goes first (`forgetRunProgress`). Then notifications to this phone
 * stop, on the server and in Firebase, and the ones it shows are removed. A session that already
 * ended can't ask the server, which is best effort: the worker sends nothing to a phone whose
 * session has expired or ended (`FcmService.deliver`).
 */
export async function unregisterPushNotifications(): Promise<void> {
  forgetRunProgress();
  const fcm = messaging();
  if (fcm) {
    const instance = fcm.getMessaging();
    const token = await fcm.getToken(instance).catch(() => null);
    if (token) await api.push.unregisterDevice({ token }).catch(() => {});
    await fcm.deleteToken(instance).catch(() => {});
  }
  await notifee.cancelAllNotifications().catch(() => {});
}
