import { Pressable, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

interface Member {
  id: string;
  name: string;
  color: string;
  emoji: string;
  role: string;
}

/** Who an @ you're typing could be, above the box; picking one completes the mention. */
export function MentionMenu<M extends Member>({
  options,
  onPick,
}: {
  options: M[];
  onPick: (member: M) => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="mention-menu"
    >
      {options.map((member) => (
        <Pressable
          key={member.id}
          onPress={() => onPick(member)}
          android_ripple={{ color: colors.muted }}
          style={styles.option}
          accessibilityRole="button"
          testID="mention-option"
        >
          <BotAvatar name={member.name} color={member.color} emoji={member.emoji} size="sm" />
          <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
            {member.name}
          </Text>
          <Text variant="caption" muted numberOfLines={1} style={{ maxWidth: "45%" }}>
            {member.role}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    borderWidth: 1,
    borderRadius: radius.xl,
    overflow: "hidden",
    paddingVertical: space(1),
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(3),
    minHeight: 44,
  },
});
