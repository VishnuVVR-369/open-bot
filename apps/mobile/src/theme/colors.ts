/**
 * Porcelain and ink, from the web app's palette (apps/web/src/app/globals.css). The interface is
 * monochrome; color only ever means someone (a teammate's color) or a signal:
 *
 * - `working`: a teammate is busy. Calm, never alarming.
 * - `attention`: something needs you (an approval, a takeover). `attentionInk` is its text color.
 * - `destructive`: something failed or will be destroyed. Nothing else is red.
 * - `done`: finished or approved.
 * - `live`: a microphone or a screen that is live right now.
 *
 * Dark mode steps up in lightness from the page to cards to what sits on cards, so layers stay
 * apart without borders doing all the work.
 */
export const palette = {
  light: {
    background: "#F3F4F6",
    surface: "#FFFFFF",
    subtle: "#ECEEF1",
    foreground: "#14161B",
    primary: "#14161B",
    primaryForeground: "#FFFFFF",
    muted: "#ECEEF1",
    mutedForeground: "#5F6570",
    destructive: "#D93F45",
    border: "#E1E4E9",
    input: "#D9DCE2",
    bubble: "#14161B",
    bubbleForeground: "#FFFFFF",
    live: "#E5484D",
    working: "#3E7BFA",
    attention: "#F5A524",
    attentionInk: "#8F5600",
    done: "#2A9D63",
  },
  dark: {
    background: "#0B0C0F",
    surface: "#16181D",
    subtle: "#1F2228",
    foreground: "#ECEEF1",
    primary: "#ECEEF1",
    primaryForeground: "#0B0C0F",
    muted: "#22252B",
    mutedForeground: "#9298A2",
    destructive: "#F0585D",
    border: "#272A31",
    input: "#33373F",
    bubble: "#2B2F37",
    bubbleForeground: "#ECEEF1",
    live: "#F0585D",
    working: "#6B9BFF",
    attention: "#F5B03C",
    attentionInk: "#F5B03C",
    done: "#3CB878",
  },
} as const;

export type Colors = { [K in keyof (typeof palette)["light"]]: string };
