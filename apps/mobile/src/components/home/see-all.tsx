import { ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import { useColors } from "@/theme";

/** The quiet link beside a section's title to the full list. */
export function SeeAll({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={12}
      style={styles.seeAll}
      testID={testID}
    >
      <Text variant="small" muted style={{ fontWeight: "500" }}>
        {label}
      </Text>
      <ChevronRight size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  seeAll: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 32 },
});
