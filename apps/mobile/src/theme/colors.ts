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
    background: "#EEEFF2",
    surface: "#FFFFFF",
    subtle: "#F3F4F6",
    foreground: "#16171B",
    primary: "#16171B",
    primaryForeground: "#FFFFFF",
    muted: "#F1F2F4",
    mutedForeground: "#636771",
    destructive: "#D23C42",
    border: "#E6E7EB",
    input: "#DDDFE4",
    bubble: "#DFE1E6",
    bubbleForeground: "#16171B",
    live: "#E5484D",
    working: "#3B74F0",
    attention: "#F5A524",
    attentionInk: "#8F5600",
    done: "#23935B",
  },
  dark: {
    background: "#0B0C0E",
    surface: "#16171B",
    subtle: "#1D1E23",
    foreground: "#E8E9ED",
    primary: "#E8E9ED",
    primaryForeground: "#0B0C0E",
    muted: "#212227",
    mutedForeground: "#90949E",
    destructive: "#EF5B60",
    border: "#25272C",
    input: "#2F3137",
    bubble: "#24262B",
    bubbleForeground: "#E8E9ED",
    live: "#F0585D",
    working: "#6194FF",
    attention: "#F5B03C",
    attentionInk: "#F5B03C",
    done: "#3CB878",
  },
} as const;

export type Colors = { [K in keyof (typeof palette)["light"]]: string };
