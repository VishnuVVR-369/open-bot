import type { TaskView, TeammateSummary } from "@open-bot/api";
import { TASK_BLOCKER_TEXT, TASK_STATUS_LABELS, type TaskBlocker } from "@open-bot/domain";
import { router } from "expo-router";
import { EllipsisVertical } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { taskHref } from "../tasks";
import { BlockerLine, DueChip, OwnerMark, StatusGlyph } from "./task-parts";

/**
 * A task in a list: its status, what holds it up, its title and notes, who owns it and when it's
 * due. Tapping it opens it; holding it, or its menu button, opens what you can do with it.
 */
export function TaskRow({
  task,
  owner,
  yourName,
  blocker,
  first,
  compact,
  onMenu,
}: {
  task: TaskView;
  owner: TeammateSummary | undefined;
  yourName: string;
  blocker: TaskBlocker | null;
  first: boolean;
  /** Home and a profile: no notes, and no menu button. */
  compact?: boolean;
  onMenu?: () => void;
}) {
  const colors = useColors();
  const done = task.status === "done";
  const notes = task.notes.trim().replace(/\s+/g, " ");
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(taskHref(task.id));
      }}
      onLongPress={
        onMenu
          ? () => {
              haptics.press();
              onMenu();
            }
          : undefined
      }
      accessibilityRole="button"
      accessibilityLabel={[
        task.title,
        TASK_STATUS_LABELS[task.status],
        blocker ? TASK_BLOCKER_TEXT[blocker] : null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={onMenu ? "Hold for more" : undefined}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID="task"
    >
      {/* Level with the title, under what holds it up when something does. */}
      <View style={[styles.glyph, blocker && { paddingTop: 1 + 16 + space(1.5) }]}>
        <StatusGlyph status={task.status} />
      </View>
      <View style={styles.body}>
        {blocker && <BlockerLine blocker={blocker} />}
        <Text
          variant="label"
          numberOfLines={compact ? 2 : 4}
          style={done ? { color: colors.mutedForeground } : undefined}
          testID="task-title"
        >
          {task.title}
        </Text>
        {notes && !done && !compact ? (
          <Text variant="small" muted numberOfLines={2}>
            {notes}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <OwnerMark owner={owner} ownerTeammateId={task.ownerTeammateId} yourName={yourName} />
          {task.dueOn && <DueChip dueOn={task.dueOn} status={task.status} />}
        </View>
      </View>
      {onMenu && !compact && (
        <Pressable
          onPress={() => {
            haptics.tap();
            onMenu();
          }}
          accessibilityRole="button"
          accessibilityLabel={`Options for ${task.title}`}
          android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
          style={styles.more}
          testID="task-more"
        >
          <EllipsisVertical size={20} color={colors.mutedForeground} />
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingLeft: space(4),
    paddingRight: space(1),
    paddingVertical: space(3.5),
    minHeight: 64,
  },
  // Centered on the title's first line (20 high, the glyph 18).
  glyph: { paddingTop: 1, width: 18 },
  body: { flex: 1, gap: space(1.5), paddingRight: space(3) },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space(3),
    rowGap: space(1),
  },
  more: {
    width: 44,
    height: 44,
    marginTop: -space(2.5),
    marginRight: -space(1),
    alignItems: "center",
    justifyContent: "center",
  },
});
