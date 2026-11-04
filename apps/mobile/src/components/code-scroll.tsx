import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";

/**
 * A box of code or output whose long lines scroll sideways inside it. While there's more to the
 * right, the right edge fades out, so a cut-off line reads as "scroll" and not as "broken". A copy
 * button sits in the corner when `copyText` is given.
 */
export function CodeScroll({
  children,
  copyText,
  background,
  padding = space(3),
  style,
}: {
  children: ReactNode;
  copyText?: string;
  background?: string;
  padding?: number;
  style?: ViewStyle;
}) {
  const colors = useColors();
  const fill = background ?? colors.subtle;
  const [width, setWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const overflows = contentWidth > width + 1;

  return (
    <View
      style={[styles.box, { backgroundColor: fill }, style]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding, paddingRight: copyText ? padding + 36 : padding }}
        onContentSizeChange={(w) => setContentWidth(w)}
        scrollEventThrottle={32}
        onScroll={(event) => {
          const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
          setAtEnd(contentOffset.x + layoutMeasurement.width >= contentSize.width - 4);
        }}
      >
        <View>{children}</View>
      </ScrollView>
      {overflows && !atEnd && (
        <View pointerEvents="none" style={styles.fade}>
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={fill} stopOpacity="0" />
                <Stop offset="1" stopColor={fill} stopOpacity="1" />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#fade)" />
          </Svg>
        </View>
      )}
      {copyText !== undefined && (
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(copyText);
            haptics.tap();
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          }}
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied" : "Copy"}
          hitSlop={8}
          android_ripple={{ color: colors.muted, borderless: true, radius: 18 }}
          style={[styles.copy, { backgroundColor: fill }]}
        >
          {copied ? (
            <Check size={15} color={colors.done} />
          ) : (
            <Copy size={15} color={colors.mutedForeground} />
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.lg, overflow: "hidden" },
  fade: { position: "absolute", top: 0, bottom: 0, right: 0, width: 40 },
  copy: {
    position: "absolute",
    top: space(1),
    right: space(1),
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
