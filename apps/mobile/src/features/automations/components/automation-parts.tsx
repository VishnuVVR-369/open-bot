import type { TeammateSummary } from "@open-bot/api";
import type { TriggerKind } from "@open-bot/domain";
import {
  AlarmClock,
  CalendarClock,
  CalendarDays,
  Eye,
  Mail,
  Webhook,
  type LucideIcon,
} from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";
import type { Automation } from "../automations";

const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
};

/** The icon for what kind of automation it is. */
export function kindIcon(automation: Pick<Automation, "type" | "kind">): LucideIcon {
  if (automation.type === "schedule")
    return automation.kind === "once" ? AlarmClock : CalendarClock;
  return TRIGGER_ICONS[automation.kind as TriggerKind];
}

/** The teammate's face with the automation's kind in a corner, as the web's rows show it. */
export function AutomationAvatar({
  automation,
  teammate,
  size = "lg",
}: {
  automation: Pick<Automation, "type" | "kind">;
  teammate: TeammateSummary | undefined;
  size?: "md" | "lg";
}) {
  const colors = useColors();
  const Icon = kindIcon(automation);
  const box = size === "lg" ? 44 : 36;
  return (
    <View style={{ width: box, height: box }}>
      {teammate ? (
        <TeammateAvatar {...teammate} size={size} />
      ) : (
        <View style={[styles.blank, { width: box, height: box, backgroundColor: colors.subtle }]} />
      )}
      <View style={[styles.badge, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Icon size={12} color={colors.foreground} />
      </View>
    </View>
  );
}

/** "Off" or "Done" beside a title, so an automation that won't run reads so at a glance. */
export function StateBadge({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={[styles.state, { backgroundColor: colors.subtle }]} testID="automation-state">
      <Text variant="caption" muted style={{ fontWeight: "500" }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A row of choices that wrap onto more lines, the picked one in ink, like the filters over a list.
 * Each is `${testID}-${key}`.
 */
export function Choices<K extends string | number>({
  options,
  value,
  onChange,
  disabled,
  testID,
}: {
  options: readonly { key: K; label: string }[];
  value: K | null;
  onChange: (key: K) => void;
  disabled?: boolean;
  testID: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.choices}>
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => {
              if (disabled) return;
              haptics.tap();
              onChange(option.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            style={[
              styles.choice,
              selected
                ? { backgroundColor: colors.primary, borderColor: colors.primary }
                : { backgroundColor: colors.surface, borderColor: colors.border },
              disabled && { opacity: 0.5 },
            ]}
            testID={`${testID}-${option.key}`}
          >
            <Text
              variant="small"
              numberOfLines={1}
              style={{
                fontWeight: "500",
                color: selected ? colors.primaryForeground : colors.foreground,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  blank: { borderRadius: 13 },
  badge: {
    position: "absolute",
    right: -5,
    bottom: -5,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  state: { paddingHorizontal: space(2), paddingVertical: 1, borderRadius: radius.full },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
  choice: {
    minHeight: 36,
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
});
