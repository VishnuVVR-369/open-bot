import { type ReactNode } from "react";
import { Pressable, View, useColorScheme, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { useColors, radius, space } from "@/theme";
import { mix } from "@/theme/mix";

/** Something that needs you, in a tinted card of its own, with who's asking. */
export function Callout({
  leading,
  onPress,
  children,
  action,
  testID,
}: {
  leading: ReactNode;
  onPress: () => void;
  children: ReactNode;
  action: string;
  testID?: string;
}) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      android_ripple={{ color: mix(colors.attention, colors.surface, 0.18) }}
      style={[
        styles.callout,
        {
          borderColor: mix(colors.attention, colors.surface, dark ? 0.28 : 0.42),
          backgroundColor: mix(colors.attention, colors.surface, dark ? 0.06 : 0.08),
        },
      ]}
      testID={testID}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>{children}</View>
      {/* The card already says "needs you"; the action itself stays ink, like every button. */}
      <View style={[styles.calloutAction, { backgroundColor: colors.primary }]}>
        <Text variant="small" style={{ color: colors.primaryForeground, fontWeight: "600" }}>
          {action}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingLeft: space(3.5),
    paddingRight: space(3),
    paddingVertical: space(3),
    overflow: "hidden",
  },
  calloutAction: {
    borderRadius: radius.full,
    paddingHorizontal: space(3.5),
    minHeight: 36,
    justifyContent: "center",
  },
});
