import type { TeammateSummary } from "@open-bot/api";
import { Check } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { YouAvatar } from "./task-parts";

/** Who a task is for: you, or one of the teammates, who can then be asked to start it. */
export function OwnerSheet({
  open,
  value,
  teammates,
  yourName,
  onPick,
  onClose,
}: {
  open: boolean;
  /** Null is you. */
  value: string | null;
  teammates: readonly TeammateSummary[];
  yourName: string;
  onPick: (ownerTeammateId: string | null) => void;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const pick = (id: string | null) => {
    haptics.tap();
    onPick(id);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Owner"
      description="Give it to a teammate to have them do it, or keep it for yourself."
      testID="owner-sheet"
    >
      <ScrollView style={{ maxHeight: height * 0.55 }} bounces={false}>
        <Choice
          leading={<YouAvatar name={yourName} size={36} />}
          title="You"
          selected={value === null}
          onPress={() => pick(null)}
          testID="owner-you"
        />
        {teammates.map((teammate) => (
          <Choice
            key={teammate.id}
            leading={<TeammateAvatar {...teammate} size="md" />}
            title={teammate.name}
            subtitle={teammate.role}
            selected={value === teammate.id}
            onPress={() => pick(teammate.id)}
            testID="owner-teammate"
          />
        ))}
      </ScrollView>
    </Sheet>
  );
}

function Choice({
  leading,
  title,
  subtitle,
  selected,
  onPress,
  testID,
}: {
  leading: ReactNode;
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.muted }}
      style={styles.choice}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={title}
      testID={testID}
    >
      {leading}
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" muted numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {selected && <Check size={20} color={colors.foreground} strokeWidth={2.4} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: 60,
    paddingHorizontal: space(5),
    paddingVertical: space(2),
  },
});
