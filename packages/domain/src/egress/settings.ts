import { z } from "zod";

/*
 * These value lists are also the egress tunnel's wire values, which the phone's Kotlin agent
 * parses. `@open-bot/egress` writes them into its test vectors, so a change here fails the
 * Kotlin tests until the phone handles it too.
 */

/** Where the computer's browser traffic leaves from. */
export const EGRESS_MODES = ["off", "prefer", "require"] as const;
export const egressModeSchema = z.enum(EGRESS_MODES);
export type EgressMode = (typeof EGRESS_MODES)[number];

export const EGRESS_OPTIONS: { value: EgressMode; label: string; description: string }[] = [
  {
    value: "prefer",
    label: "Prefer my devices",
    description:
      "Browse from your own connection while your Mac or phone can carry it, and go direct from the cloud when neither can.",
  },
  {
    value: "require",
    label: "Only through my devices",
    description:
      "Pages load only through your Mac or phone. While neither is connected, the browser can't load pages.",
  },
  {
    value: "off",
    label: "Off",
    description: "Always browse straight from the cloud computer.",
  },
];

/** When your phone carries the computer's browser traffic: never, while the Mac is offline, or first. */
export const PHONE_MODES = ["off", "fallback", "always"] as const;
export const phoneModeSchema = z.enum(PHONE_MODES);
export type PhoneMode = (typeof PHONE_MODES)[number];

export const PHONE_MODE_OPTIONS: {
  value: PhoneMode;
  label: string;
  description: string;
}[] = [
  {
    value: "fallback",
    label: "When my Mac is offline",
    description:
      "Your phone wakes up and carries the traffic only while your Mac isn't connected and teammates are browsing.",
  },
  {
    value: "always",
    label: "Always, before my Mac",
    description:
      "Your phone stays connected and carries the traffic first; your Mac takes over when the phone can't.",
  },
  {
    value: "off",
    label: "Never",
    description: "Your phone never carries the computer's traffic.",
  },
];

/** The owner's devices that can carry the computer's traffic: the Mac app, or the phone app. */
export const EGRESS_AGENT_KINDS = ["desktop", "phone"] as const;
export const egressAgentKindSchema = z.enum(EGRESS_AGENT_KINDS);
export type EgressAgentKind = (typeof EGRESS_AGENT_KINDS)[number];

/** Not `off`: a mode in which the phone does carry traffic, at least sometimes. */
export type CarryingPhoneMode = Exclude<PhoneMode, "off">;

/** How far waking a phone got: the first push, a retry, or asking the owner to open the app. */
export const PHONE_WAKE_STAGES = ["wake", "retry", "ask"] as const;
export const phoneWakeStageSchema = z.enum(PHONE_WAKE_STAGES);
export type PhoneWakeStage = (typeof PHONE_WAKE_STAGES)[number];

/** Why a phone can't carry traffic right now, by its own rules or its owner's choice. */
export const UNAVAILABLE_REASONS = [
  "wifi-only",
  "data-cap",
  "low-battery",
  "low-power-standby",
  "stopped",
] as const;
export const unavailableReasonSchema = z.enum(UNAVAILABLE_REASONS);
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
