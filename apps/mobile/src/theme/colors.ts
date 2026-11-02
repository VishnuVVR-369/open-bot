/**
 * The web app's palette (apps/web/src/app/globals.css): porcelain and ink. The interface is
 * monochrome; color only ever means someone (a teammate's color) or a signal light.
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
    mutedForeground: "#646A75",
    destructive: "#D93F45",
    border: "#E1E4E9",
    input: "#D9DCE2",
    live: "#E5484D",
    manual: "#F5A524",
    manualInk: "#9A5D00",
    waiting: "#3E7BFA",
    done: "#2A9D63",
  },
  dark: {
    background: "#0E0F12",
    surface: "#15171B",
    subtle: "#1B1D22",
    foreground: "#ECEEF1",
    primary: "#ECEEF1",
    primaryForeground: "#0E0F12",
    muted: "#1F2227",
    mutedForeground: "#8D929C",
    destructive: "#F0585D",
    border: "#25282E",
    input: "#2D3037",
    live: "#F0585D",
    manual: "#F5B03C",
    manualInk: "#F5B03C",
    waiting: "#5B8FFF",
    done: "#3CB878",
  },
} as const;

export type Colors = { [K in keyof (typeof palette)["light"]]: string };
