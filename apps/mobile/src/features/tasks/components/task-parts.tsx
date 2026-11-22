import type { TeammateSummary } from "@open-bot/api";
import {
  dueLabel,
  dueState,
  TASK_BLOCKER_TEXT,
  type TaskBlocker,
  type TaskStatus,
} from "@open-bot/domain";
import { CalendarDays, Check } from "lucide-react-native";
import { StyleSheet, useColorScheme, View } from "react-native";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { Text } from "@/components/text";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** Your own mark, as the web's board shows it: your initial on a round ink tile. */
export function YouAvatar({ name, size = 24 }: { name: string; size?: number }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.you,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primary },
      ]}
      accessible={false}
    >
      <Text
        style={{
          fontFamily: fonts.sans,
          fontWeight: "600",
          fontSize: size * 0.46,
          lineHeight: size * 0.6,
          color: colors.primaryForeground,
        }}
      >
        {name.trim().slice(0, 1).toUpperCase() || "Y"}
      </Text>
    </View>
  );
}

/** Who owns a task: a teammate's face and name, or you. */
export function OwnerMark({
  owner,
  ownerTeammateId,
  yourName,
}: {
  owner: TeammateSummary | undefined;
  ownerTeammateId: string | null;
  yourName: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.owner}>
      {owner ? (
        <TeammateAvatar {...owner} size="xs" />
      ) : ownerTeammateId ? (
        // A teammate who has left the team: the task stays, without a face.
        <View style={[styles.formerAvatar, { borderColor: colors.input }]} />
      ) : (
        <YouAvatar name={yourName} />
      )}
      <Text variant="caption" muted numberOfLines={1} style={styles.ownerName}>
        {owner?.name ?? (ownerTeammateId ? "Former teammate" : "You")}
      </Text>
    </View>
  );
}

/** When a task is due: amber once it's late, in ink on the day. */
export function DueChip({ dueOn, status }: { dueOn: string; status: TaskStatus }) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  const state = dueState({ dueOn, status });
  const overdue = state === "overdue";
  const color = overdue
    ? colors.attentionInk
    : state === "today"
      ? colors.foreground
      : colors.mutedForeground;
  return (
    <View
      style={[
        styles.due,
        overdue && {
          backgroundColor: mix(colors.attention, colors.surface, dark ? 0.16 : 0.14),
          paddingHorizontal: space(1.5),
        },
      ]}
      accessibilityLabel={`Due ${dueLabel(dueOn)}${overdue ? ", overdue" : ""}`}
      testID="task-due"
    >
      <CalendarDays size={12} color={color} />
      <Text
        variant="caption"
        style={{ color, fontWeight: state === "today" || overdue ? "500" : "400" }}
      >
        {dueLabel(dueOn)}
      </Text>
    </View>
  );
}

/** What holds a task up, as the web's card says it: amber when it's you, gray when it's the computer. */
export function BlockerLine({ blocker }: { blocker: TaskBlocker }) {
  const colors = useColors();
  const paused = blocker === "paused";
  return (
    <View style={styles.blocker} testID="task-state">
      <View
        style={[
          styles.dot,
          { backgroundColor: paused ? colors.mutedForeground : colors.attention },
        ]}
      />
      <Text
        variant="caption"
        style={{ color: paused ? colors.mutedForeground : colors.attentionInk, fontWeight: "500" }}
      >
        {paused ? `${TASK_BLOCKER_TEXT.paused}, computer offline` : TASK_BLOCKER_TEXT[blocker]}
      </Text>
    </View>
  );
}

/** A status's light: gray to do, blue in progress, green done. */
export function statusColor(status: TaskStatus, colors: ReturnType<typeof useColors>): string {
  return status === "doing" ? colors.working : status === "done" ? colors.done : colors.input;
}

/**
 * The mark at the start of a task's row: an empty ring to do, a blue ring with a dot in progress,
 * and a green check when done.
 */
export function StatusGlyph({ status }: { status: TaskStatus }) {
  const colors = useColors();
  if (status === "done")
    return (
      <View style={[styles.glyph, { backgroundColor: colors.done, borderColor: colors.done }]}>
        <Check size={11} color={colors.surface} strokeWidth={3.5} />
      </View>
    );
  return (
    <View
      style={[
        styles.glyph,
        {
          borderColor: status === "doing" ? colors.working : colors.mutedForeground,
          opacity: status === "doing" ? 1 : 0.6,
        },
      ]}
    >
      {status === "doing" && <View style={[styles.core, { backgroundColor: colors.working }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  you: { alignItems: "center", justifyContent: "center" },
  owner: { flexDirection: "row", alignItems: "center", gap: space(1.5), flexShrink: 1 },
  ownerName: { flexShrink: 1 },
  formerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  due: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    borderRadius: radius.sm,
    minHeight: 20,
  },
  blocker: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  dot: { width: 6, height: 6, borderRadius: 3 },
  glyph: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  core: { width: 8, height: 8, borderRadius: 4 },
});
