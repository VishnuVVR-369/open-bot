import { Text as NativeText, type TextProps, type TextStyle } from "react-native";
import { fonts, useColors } from "@/theme";

const VARIANTS = {
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  label: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  title: { fontFamily: fonts.heading, fontSize: 22, lineHeight: 28, fontWeight: "600" },
  heading: { fontFamily: fonts.heading, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  /** A section's name over a group: sentence case, never shouted. */
  section: { fontFamily: fonts.heading, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  /** A small label inside a card or above a field. */
  overline: { fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 16, fontWeight: "600" },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
} satisfies Record<string, TextStyle>;

export type TextVariant = keyof typeof VARIANTS;

/** Text in the app's type: the variant sets the font and size; `muted` is the secondary color. */
export function Text({
  variant = "body",
  muted,
  style,
  ...props
}: TextProps & { variant?: TextVariant; muted?: boolean }) {
  const colors = useColors();
  return (
    <NativeText
      {...props}
      style={[
        VARIANTS[variant],
        { color: muted ? colors.mutedForeground : colors.foreground },
        style,
      ]}
    />
  );
}
