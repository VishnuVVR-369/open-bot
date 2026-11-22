import Constants from "expo-constants";

/** Whether this build has a Firebase config, so it can get push notifications. */
export const hasFirebase = Constants.expoConfig?.extra?.firebase === true;

export type MessagingModule = typeof import("@react-native-firebase/messaging");

/** Firebase messaging, or null for a build without Firebase (it would fail to load). */
export function messaging(): MessagingModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return hasFirebase ? (require("@react-native-firebase/messaging") as MessagingModule) : null;
}
