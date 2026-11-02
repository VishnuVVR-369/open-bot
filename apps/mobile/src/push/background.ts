import notifee from "@notifee/react-native";
import { hasFirebase } from "./firebase";
import { handleNotificationEvent, handlePushData } from "./notifications";
import { parsePushData } from "./payload";

/**
 * Runs before the app's UI, and in Android's headless JS task when a message or a notification
 * button arrives while the app is closed.
 */
notifee.onBackgroundEvent(handleNotificationEvent);

if (hasFirebase) {
  // Required only when there is a Firebase config; without one, the native module isn't set up.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getMessaging, setBackgroundMessageHandler } = require("@react-native-firebase/messaging");
  setBackgroundMessageHandler(
    getMessaging(),
    async (message: { data?: Record<string, unknown> }) => {
      const data = parsePushData(message.data);
      if (data) await handlePushData(data);
    },
  );
}
