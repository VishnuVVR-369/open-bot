import { egressModeSchema, phoneEgressModeSchema } from "@open-bot/domain";
import { z } from "zod";

/**
 * Where the computer's browser traffic leaves from: your Mac, your phone, or the cloud itself.
 * The worker builds this; the web app and the phone show it.
 */

export { egressModeSchema, phoneEgressModeSchema };
export const unavailableReasonSchema = z.enum([
  "wifi-only",
  "data-cap",
  "low-battery",
  "low-power-standby",
  "stopped",
]);
export type UnavailableReasonView = z.infer<typeof unavailableReasonSchema>;

const statsSchema = z.object({
  openStreams: z.number().int().nonnegative(),
  bytesIn: z.number().nonnegative(),
  bytesOut: z.number().nonnegative(),
});

export const egressAgentViewSchema = z.object({
  kind: z.enum(["desktop", "phone"]),
  id: z.string(),
  name: z.string(),
  /** `active` carries new connections; `standby` only finishes the ones it has. */
  role: z.enum(["active", "standby"]),
  since: z.string(),
  stats: statsSchema.nullable(),
});

export const egressPhoneViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  /** Being woken right now, and how far the wake got. */
  waking: z.object({ since: z.string(), stage: z.enum(["wake", "retry", "ask"]) }).nullable(),
  /** The phone said it can't help, and why; it isn't asked again until `until`. */
  unavailable: z
    .object({ reason: unavailableReasonSchema, message: z.string(), until: z.string() })
    .nullable(),
  /** When the last wake went unanswered, if the phone hasn't connected since. */
  unanswered: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

export const egressPathSchema = z.enum(["desktop", "phone", "direct", "waiting", "blocked"]);
export type EgressPath = z.infer<typeof egressPathSchema>;

export const egressStatusSchema = z.object({
  mode: egressModeSchema,
  /** A device (Mac or phone) carries new connections. */
  agentOnline: z.boolean(),
  /** The worker is connected to the computer's side of the tunnel. */
  computerConnected: z.boolean(),
  /** The active device's counters. */
  stats: statsSchema.nullable(),
  /** Since when the active device has been connected. */
  agentSince: z.string().nullable(),
  phoneMode: phoneEgressModeSchema,
  /** Where new connections go right now. */
  path: egressPathSchema,
  agents: z.array(egressAgentViewSchema),
  phones: z.array(egressPhoneViewSchema),
});
export type EgressStatusView = z.infer<typeof egressStatusSchema>;

/** What to show while the worker can't be reached. */
export const OFFLINE_EGRESS_STATUS: EgressStatusView = {
  mode: "prefer",
  agentOnline: false,
  computerConnected: false,
  stats: null,
  agentSince: null,
  phoneMode: "fallback",
  path: "direct",
  agents: [],
  phones: [],
};

export const egressDeviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  online: z.boolean(),
});
export type EgressDeviceView = z.infer<typeof egressDeviceViewSchema>;

export const UNAVAILABLE_MESSAGES: Record<UnavailableReasonView, string> = {
  "wifi-only": "Phone is on mobile data",
  "data-cap": "Phone reached its mobile data limit",
  "low-battery": "Phone battery is low",
  "low-power-standby": "Phone's Low Power Standby is on",
  stopped: "You stopped it on your phone",
};

/** The short label for where traffic goes, and a line saying why, for chips and settings. */
export function describeEgress(status: EgressStatusView): {
  label: string;
  detail: string | null;
} {
  const label = {
    desktop: "Through your Mac",
    phone: "Through your phone",
    direct: "Direct from the cloud",
    waiting: "Waiting for your phone",
    blocked: "Browsing paused",
  }[status.path];
  const unavailable = status.phones.find((phone) => phone.unavailable)?.unavailable;
  const unanswered = status.phones.some((phone) => phone.unanswered && !phone.online);
  const detail =
    status.path === "desktop" || status.path === "phone"
      ? null
      : status.mode === "off"
        ? "Routing through your devices is off."
        : unavailable
          ? unavailable.message
          : unanswered
            ? "Your phone didn't answer. Open open-bot on it."
            : status.path === "blocked"
              ? "Neither your Mac nor your phone is connected."
              : null;
  return { label, detail };
}
