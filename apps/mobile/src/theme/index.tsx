import { useColorScheme } from "react-native";
import { palette, type Colors } from "./colors";

export { palette, type Colors };

/** Type, as on the web: Onest for text, Familjen Grotesk for headings, JetBrains Mono for code. */
export const fonts = {
  sans: "Onest",
  heading: "Familjen Grotesk",
  mono: "JetBrains Mono",
} as const;

/** Spacing on a 4-point grid, and the web's radius (0.625rem). */
export const space = (n: number) => n * 4;
export const radius = { sm: 6, md: 8, lg: 10, xl: 14, full: 999 } as const;

/** The colors for the system theme, which the app follows. */
export function useColors(): Colors {
  return palette[useColorScheme() === "dark" ? "dark" : "light"];
}
