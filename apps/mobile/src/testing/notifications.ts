import * as Linking from "expo-linking";
import { E2E_NOTIFICATIONS } from "../lib/config";
import { handlePushData } from "../push/notifications";
import { parsePushData } from "../push/payload";

/** Only loaded by the explicitly enabled development entry point. */
async function receive(url: string | null) {
  if (!url || !__DEV__ || !E2E_NOTIFICATIONS) return;
  try {
    const link = new URL(url);
    if (link.protocol !== "openbot:") return;
    const raw = link.searchParams.get("e2ePush");
    if (!raw) return;
    const data = parsePushData(JSON.parse(raw));
    if (data) await handlePushData(data);
  } catch (error) {
    console.warn("Couldn't display the local test notification", error);
  }
}

Linking.addEventListener("url", ({ url }) => void receive(url));
void Linking.getInitialURL().then(receive);
