import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { space, useColors } from "@/theme";

/** A row in a list: something on the left, a title and a line under it, and an aside. */
export function ListRow({
  leading,
  title,
  subtitle,
  aside,
  onPress,
  testID,
}: {
  leading: ReactNode;
  title: string;
  subtitle?: ReactNode;
  aside?: ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.muted }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
      accessibilityRole="button"
      testID={testID}
    >
      {leading}
      <View style={styles.text}>
        <Text variant="label" numberOfLines={1}>
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

export function Separator() {
  const colors = useColors();
  return (
    <View
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 68 }}
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
