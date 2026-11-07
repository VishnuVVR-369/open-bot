import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, useColorScheme } from "react-native";
import { useReducedMotion } from "@/lib/motion";
import { useColors } from "@/theme";
import { mix } from "@/theme/mix";

const TRACK_W = 48;
const TRACK_H = 28;
const INSET = 3;
const THUMB = TRACK_H - INSET * 2;
const TRAVEL = TRACK_W - THUMB - INSET * 2;

/**
 * An on/off switch drawn in the app's colors, so it looks the same on every phone: the thumb
 * always sits inside its track. On is an ink track (light in dark mode) with a thumb in the
 * page's color; off is a quiet track with a white thumb (a gray one in dark mode). A row that
 * wraps it can be the control itself and hide this one from TalkBack.
 */
export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
  importantForAccessibility,
  testID,
}: {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  importantForAccessibility?: "auto" | "yes" | "no" | "no-hide-descendants";
  testID?: string;
}) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  const reduced = useReducedMotion();
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(position, {
      toValue: value ? 1 : 0,
      duration: reduced ? 0 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [value, reduced, position]);

  return (
    <Pressable
      onPress={() => onValueChange?.(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={importantForAccessibility}
      hitSlop={10}
      testID={testID}
      style={[
        styles.track,
        value
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.input, borderColor: colors.input },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Animated.View
        style={[
          styles.thumb,
          {
            backgroundColor: value
              ? colors.primaryForeground
              : dark
                ? mix(colors.foreground, colors.surface, 0.5)
                : colors.surface,
            transform: [
              {
                translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }),
              },
            ],
          },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    borderWidth: 0,
    padding: INSET,
    justifyContent: "center",
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    elevation: 1,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1 },
  },
});
