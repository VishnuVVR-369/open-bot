import { ScrollView, Pressable, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { radius, space, useColors } from "@/theme";

/** A row of filters over a list: the selected one in ink, the rest outlined. */
export function FilterChips<K extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filters}
      style={{ flexGrow: 0 }}
    >
      {options.map((entry) => {
        const selected = entry.key === value;
        return (
          <Pressable
            key={entry.key}
            onPress={() => {
              haptics.tap();
              animateLayout();
              onChange(entry.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.chip,
              selected
                ? { backgroundColor: colors.primary, borderColor: colors.primary }
                : { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
            testID={`filter-${entry.key}`}
          >
            <Text
              variant="small"
              style={{
                fontWeight: "500",
                color: selected ? colors.primaryForeground : colors.foreground,
              }}
            >
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  filters: {
    paddingHorizontal: space(4),
    paddingTop: space(2),
    paddingBottom: space(2),
    gap: space(2),
  },
  chip: {
    minHeight: 36,
    // Narrow enough that every filter fits a phone's width without running off the edge.
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
});
