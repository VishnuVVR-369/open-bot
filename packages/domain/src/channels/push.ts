import type { CarryingPhoneMode, PhoneWakeStage } from "../egress/settings";

/** What a push to the phone app is for. */
export const NATIVE_PUSH_TYPES = [
  "notification",
  "dismiss",
  "egress-needed",
  "run-progress",
] as const;
export type NativePushType = (typeof NATIVE_PUSH_TYPES)[number];

/** The stages of waking a phone that send it a push (a retry is a second `wake`). */
export type EgressPushStage = Exclude<PhoneWakeStage, "retry">;

/**
 * What a phone gets: always a data message, never a notification message, so the app renders it
 * itself (with actions) and can drop one that's stale. Every value is a string, as FCM requires.
 */
export interface NativePushData {
  type: NativePushType;
  kind?: string;
  title?: string;
  body?: string;
  /** Replaces, or with `dismiss` removes, an earlier notification with the same tag. */
  tag: string;
  /** Where tapping it goes, as a route in the app. */
  url?: string;
  /** The teammate it's from: a Reply mentions them, and a takeover request opens their screen. */
  teammateId?: string;
  /**
   * Temporary: the same id under its old name, for phones still on the build that reads `botId`.
   * Removed in the database-rename PR (V6), which deploys after the new phone build is installed.
   */
  botId?: string; // vocabulary: allow (temporary, see above)
  chatId?: string;
  runId?: string;
  /** A page to open, for a teammate's reply that published one. */
  pageId?: string;
  approvalId?: string;
  /** "true" when approving needs your fingerprint, like for a purchase. */
  approvalNeedsBiometric?: "true" | "false";
  takeoverId?: string;
  /** `egress-needed`: `wake` starts the phone's connection silently; `ask` asks you to tap. */
  stage?: EgressPushStage;
  /** When it was sent (ISO), so the phone can ignore a wake that arrives too late to matter. */
  sentAt?: string;
  /**
   * `egress-needed`: the phone mode now. A phone that was off when it changed would otherwise
   * act on the one it has stored (and, with `off` stored, never learn of the change).
   */
  phoneMode?: CarryingPhoneMode;
}
