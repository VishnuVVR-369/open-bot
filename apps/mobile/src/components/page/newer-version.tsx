import { X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

/** Floats over an older version when a newer one is ready, to show it or dismiss the offer. */
export function NewerVersion({
  number,
  onShow,
  onDismiss,
}: {
  number: number;
  onShow: () => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.newerWrap} pointerEvents="box-none">
      <View
        style={[styles.newer, { backgroundColor: colors.surface, borderColor: colors.border }]}
        testID="page-newer"
      >
        <Text variant="small" style={{ fontWeight: "500" }}>
          Version {number} is ready
        </Text>
        <Pressable
          onPress={onShow}
          accessibilityRole="button"
          style={[styles.newerShow, { backgroundColor: colors.primary }]}
        >
          <Text variant="small" style={{ color: colors.primaryForeground, fontWeight: "600" }}>
            Show it
          </Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
          style={styles.newerDismiss}
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  newerWrap: {
    position: "absolute",
    top: space(3),
    left: 0,
    right: 0,
    alignItems: "center",
  },
  newer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.full,
    paddingLeft: space(4),
    paddingRight: space(1.5),
    paddingVertical: space(1.5),
    elevation: 4,
    shadowColor: "#000000",
  },
  newerShow: {
    borderRadius: radius.full,
    paddingHorizontal: space(3),
    minHeight: 30,
    justifyContent: "center",
  },
  newerDismiss: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
});
