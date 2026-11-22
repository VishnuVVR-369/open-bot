import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "@open-bot/domain";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";
import { statusColor } from "./task-parts";

/** Where a task stands, as one control with the board's three columns. */
export function StatusPicker({
  value,
  onChange,
}: {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.track, { backgroundColor: colors.subtle, borderColor: colors.border }]}
      accessibilityRole="radiogroup"
      accessibilityLabel="Status"
    >
      {TASK_STATUSES.map((status) => {
        const selected = status === value;
        return (
          <Pressable
            key={status}
            onPress={() => {
              if (selected) return;
              haptics.tap();
              onChange(status);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={TASK_STATUS_LABELS[status]}
            style={[
              styles.segment,
              selected && {
                backgroundColor: colors.surface,
                borderColor: colors.input,
              },
            ]}
            testID={`task-status-${status}`}
          >
            <View
              style={[
                styles.light,
                {
                  backgroundColor:
                    status === "todo" ? colors.mutedForeground : statusColor(status, colors),
                  opacity: selected ? 1 : 0.7,
                },
              ]}
            />
            <Text
              variant="small"
              style={{
                fontWeight: selected ? "600" : "500",
                color: selected ? colors.foreground : colors.mutedForeground,
              }}
            >
              {TASK_STATUS_LABELS[status]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth * 2,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(2),
    borderRadius: radius.xl - 3,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: "transparent",
  },
  light: { width: 7, height: 7, borderRadius: 3.5 },
});
