import type { CarryingPhoneMode, PhoneWakeStage } from "../egress/settings";
import type { RunProgressState } from "./run-progress";

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
  /**
   * When it was sent (ISO), so the phone can ignore a wake that arrives too late to matter, and a
   * `run-progress` update that arrives after a newer one.
   */
  sentAt?: string;
  /**
   * `egress-needed`: the phone mode now. A phone that was off when it changed would otherwise
   * act on the one it has stored (and, with `off` stored, never learn of the change).
   */
  phoneMode?: CarryingPhoneMode;
  /** `run-progress`: where the run is; `ended` removes its notification for good. */
  runState?: RunProgressState;
  /** `run-progress`: when the run started (ISO), for the time it has been going. */
  startedAt?: string;
  /** `run-progress`: how many steps of the teammate's plan are done, with `stepsTotal`. */
  stepsDone?: string;
  stepsTotal?: string;
}
