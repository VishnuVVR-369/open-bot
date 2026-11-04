import { useColorScheme } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import { palette, useColors } from "@/theme";

/**
 * The open-bot mark, as on the app icon: a screen with its live dot, on an ink tile. It keeps the
 * icon's colors in both themes, so it reads as the same app; in dark mode a hairline keeps the
 * tile from sinking into the page.
 */
export function AppMark({ size = 64 }: { size?: number }) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  // The drawing is 1024 wide; this is one screen pixel in its units.
  const hairline = 1024 / size;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      accessibilityRole="image"
      accessibilityLabel="open-bot"
    >
      <Rect
        x={dark ? hairline / 2 : 0}
        y={dark ? hairline / 2 : 0}
        width={dark ? 1024 - hairline : 1024}
        height={dark ? 1024 - hairline : 1024}
        rx={232}
        fill={palette.light.primary}
        stroke={dark ? colors.input : undefined}
        strokeWidth={dark ? hairline : 0}
      />
      <Rect
        x={208}
        y={272}
        width={608}
        height={400}
        rx={64}
        fill="none"
        stroke={palette.light.background}
        strokeWidth={64}
      />
      <Circle cx={720} cy={368} r={48} fill={palette.light.live} />
      <Rect x={368} y={752} width={288} height={64} rx={32} fill={palette.light.background} />
    </Svg>
  );
}
