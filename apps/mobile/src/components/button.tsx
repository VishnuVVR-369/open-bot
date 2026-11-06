import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { radius, space, useColors } from "@/theme";
import { Text } from "./text";

type Variant = "primary" | "outline" | "ghost" | "destructive";

/** A button in the web app's style: ink on porcelain, an outline, or just text. */
export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  busy,
  icon,
  style,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const colors = useColors();
  const look = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: "transparent" },
    outline: { bg: colors.surface, fg: colors.foreground, border: colors.input },
    ghost: { bg: "transparent", fg: colors.foreground, border: "transparent" },
    destructive: { bg: colors.surface, fg: colors.destructive, border: colors.input },
  }[variant];
  // An unavailable primary button steps back to a quiet fill instead of a faded slab of ink,
  // which reads as grey on grey in the dark.
  const unavailable = disabled && !busy;
  if (unavailable && variant === "primary") {
    look.bg = colors.muted;
    look.fg = colors.mutedForeground;
  }
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      android_ripple={{ color: colors.muted, borderless: false }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: look.bg,
          borderColor: look.border,
          // Busy is still at work, so only an unavailable button fades.
          opacity: unavailable ? (variant === "primary" ? 1 : 0.5) : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {/* The label keeps its place under the spinner, so the button doesn't change size. */}
      <View style={[styles.content, busy && { opacity: 0 }]}>
        {icon}
        <Text variant="label" style={{ color: look.fg }}>
          {title}
        </Text>
      </View>
      {busy && <ActivityIndicator size="small" color={look.fg} style={StyleSheet.absoluteFill} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: space(4),
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  content: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
