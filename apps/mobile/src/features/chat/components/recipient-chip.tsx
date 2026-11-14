import { AlertCircle, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * Whom a draft is for, above the box: a reply kept from a notification is for the teammate who
 * wrote. One who's no longer in the chat can't get it: tap to pick who should, or remove them.
 */
export function RecipientChip({
  member,
  onPick,
  onRemove,
}: {
  member: { name: string; color: string; emoji: string } | undefined;
  onPick: () => void;
  onRemove: () => void;
}) {
  const colors = useColors();
  const label = member ? `To ${member.name}` : "To a teammate who isn't in this chat";
  return (
    <View
      style={[
        styles.chip,
        {
          borderColor: member ? colors.border : mix(colors.destructive, colors.surface, 0.5),
          backgroundColor: colors.surface,
        },
      ]}
      testID={member ? "recipient" : "recipient-missing"}
    >
      <Pressable
        onPress={onPick}
        disabled={Boolean(member)}
        accessibilityRole={member ? undefined : "button"}
        accessibilityLabel={member ? label : `${label}. Pick who it's for`}
        hitSlop={6}
        style={styles.label}
      >
        {member ? (
          <TeammateAvatar name={member.name} color={member.color} emoji={member.emoji} size="xs" />
        ) : (
          <AlertCircle size={14} color={colors.destructive} />
        )}
        <Text variant="small" numberOfLines={1} style={{ fontSize: 13.5, flexShrink: 1 }}>
          {label}
        </Text>
      </Pressable>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={member ? `Don't address it to ${member.name}` : "Remove"}
        testID="recipient-remove"
      >
        <X size={15} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1.5),
  },
  label: { flexDirection: "row", alignItems: "center", gap: space(2), flexShrink: 1 },
});
