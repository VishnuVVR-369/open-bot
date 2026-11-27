import { isSuggestion, type MemoryItem } from "@open-bot/domain";
import { Pin } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";
import { memoryMeta } from "../memory";

/** A "Suggestion" mark, for a memory a teammate suggested that you haven't confirmed. */
export function SuggestionBadge() {
  const colors = useColors();
  return (
    <View style={[styles.badge, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
      <Text variant="caption" style={{ fontWeight: "600" }}>
        Suggestion
      </Text>
    </View>
  );
}

/** One memory in a list: what it says, and above it its type, who saved it and how it stands. */
export function MemoryRow({
  item,
  savedBy,
  first,
  onPress,
}: {
  item: MemoryItem;
  /** The name of the teammate that saved it, when one did. */
  savedBy: string | null;
  first: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const meta = memoryMeta(item, savedBy);
  const suggestion = isSuggestion(item);
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={[suggestion ? "Suggestion" : null, item.content, ...meta]
        .filter(Boolean)
        .join(", ")}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID="memory-row"
    >
      <View style={styles.meta}>
        {suggestion && <SuggestionBadge />}
        {item.pinned && <Pin size={12} color={colors.mutedForeground} />}
        <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
          {meta.join(" · ")}
        </Text>
      </View>
      <Text numberOfLines={4}>{item.content}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    gap: space(1.5),
    minHeight: 64,
    justifyContent: "center",
  },
  meta: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  badge: {
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(2),
    paddingVertical: 1,
  },
});
