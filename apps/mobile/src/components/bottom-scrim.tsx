import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { space, useColors } from "@/theme";

/**
 * A short fade into the page's color behind the gesture bar, for a screen without a tab bar: text
 * scrolling under the system's handle fades out instead of being struck through by it. Put it last
 * in the screen, over its scroll view, which should also end `useSafeBottom()` clear of it.
 */
export function BottomScrim() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  if (insets.bottom === 0) return null;
  const height = insets.bottom + space(6);
  return (
    <View pointerEvents="none" style={[styles.scrim, { height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.background} stopOpacity={0} />
            <Stop offset="0.45" stopColor={colors.background} stopOpacity={0.85} />
            <Stop offset="1" stopColor={colors.background} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill="url(#scrim)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
