import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type TextStyle } from "react-native";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** A row in a list: something on the left, a title and a line under it, and an aside. */
export function ListRow({
  leading,
  title,
  titleStyle,
  subtitle,
  aside,
  onPress,
  disabled = false,
  testID,
}: {
  leading: ReactNode;
  title: string;
  titleStyle?: TextStyle;
  subtitle?: ReactNode;
  aside?: ReactNode;
  onPress: () => void;
  /** Shown faded and can't be pressed. */
  disabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      android_ripple={disabled ? undefined : { color: colors.muted }}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.subtle },
        disabled && { opacity: 0.5 },
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
    >
      {leading}
      <View style={styles.text}>
        <Text variant="label" numberOfLines={1} style={titleStyle}>
          {title}
        </Text>
        {subtitle ? (
          typeof subtitle === "string" ? (
            <Text variant="small" muted numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        ) : null}
      </View>
      {aside}
    </Pressable>
  );
}

/** The line between rows, starting where the text does: after a list avatar (44 wide) by default. */
export function Separator({ inset = space(4) + 44 + space(3) }: { inset?: number }) {
  const colors = useColors();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginLeft: inset,
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  text: { flex: 1, gap: 2 },
});
