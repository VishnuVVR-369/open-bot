/** Where the computer's browser traffic leaves from. */
export type EgressModeSetting = "off" | "prefer" | "require";

export const EGRESS_OPTIONS: { value: EgressModeSetting; label: string; description: string }[] = [
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

/** When your phone carries the computer's browser traffic. */
export type PhoneEgressSetting = "off" | "fallback" | "always";

export const PHONE_EGRESS_OPTIONS: {
  value: PhoneEgressSetting;
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
