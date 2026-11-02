import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
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
  style?: ViewStyle;
  testID?: string;
}) {
  const colors = useColors();
  const look = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: "transparent" },
    outline: { bg: colors.surface, fg: colors.foreground, border: colors.input },
    ghost: { bg: "transparent", fg: colors.foreground, border: "transparent" },
    destructive: { bg: colors.surface, fg: colors.destructive, border: colors.input },
  }[variant];
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
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={look.fg} />
      ) : (
        <View style={styles.content}>
          {icon}
          <Text variant="label" style={{ color: look.fg }}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: space(4),
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  content: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
