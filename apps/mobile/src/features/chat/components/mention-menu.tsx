import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

export interface Member {
  id: string;
  name: string;
  color: string;
  emoji: string;
  role: string;
}

/** A teammate to pick: avatar, name and role, tappable across the whole width. */
export function MemberOption<M extends Member>({
  member,
  onPick,
  style,
  testID,
}: {
  member: M;
  onPick: (member: M) => void;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onPick(member)}
      android_ripple={{ color: colors.muted }}
      style={[styles.option, style]}
      accessibilityRole="button"
      testID={testID}
    >
      <TeammateAvatar name={member.name} color={member.color} emoji={member.emoji} size="sm" />
      <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
        {member.name}
      </Text>
      <Text variant="caption" muted numberOfLines={1} style={{ maxWidth: "45%" }}>
        {member.role}
      </Text>
    </Pressable>
  );
}

/**
 * Who an @ you're typing could be, above the box; picking one completes the mention. It isn't
 * scrolled, so it takes at most a few options (`mentionOptions()` gives six).
 */
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
        <MemberOption key={member.id} member={member} onPick={onPick} testID="mention-option" />
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
