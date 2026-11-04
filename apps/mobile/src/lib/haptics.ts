import * as Haptics from "expo-haptics";
import { getPreferences } from "@/lib/preferences";

/**
 * Small, consistent touches of feedback. `tap` for choosing something, `success` when something
 * you asked for went through, `warning` for a refusal or a risky step, `error` when it failed.
 * All of them respect the Haptics setting.
 */
function when(run: () => Promise<void>) {
  if (!getPreferences().haptics) return;
  void run().catch(() => {});
}

export const haptics = {
  tap: () => when(() => Haptics.selectionAsync()),
  press: () => when(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () => when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
