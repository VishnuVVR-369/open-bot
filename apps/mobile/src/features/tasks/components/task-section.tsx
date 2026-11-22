import type { TaskView, TeammateSummary } from "@open-bot/api";
import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { SeeAll } from "@/features/home/components/see-all";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { useTaskBlockers, useYourName } from "../hooks";
import { newTaskHref, TASKS_HREF } from "../tasks";
import { TaskRow } from "./task-row";

/**
 * A few tasks from the board under a title, with the way to the whole board and a row to add
 * one: Home shows what needs you first, a teammate's profile shows their open tasks.
 */
export function TaskSection({
  tasks,
  teammates,
  seeAllLabel,
  addLabel,
  addFor = null,
  emptyText,
  testID,
}: {
  tasks: readonly TaskView[];
  teammates: readonly TeammateSummary[];
  seeAllLabel: string;
  addLabel: string;
  /** The teammate a task added here is for; you, without one. */
  addFor?: string | null;
  /** Said in place of the rows when there are none. */
  emptyText: string;
  testID?: string;
}) {
  const colors = useColors();
  const blockerOf = useTaskBlockers();
  const yourName = useYourName();
  return (
    <View testID={testID}>
      <Section
        title="Tasks"
        action={
          <SeeAll
            label={seeAllLabel}
            onPress={() => router.push(TASKS_HREF)}
            testID={testID ? `${testID}-all` : undefined}
          />
        }
      >
        <Card>
          {tasks.length === 0 && (
            <View style={styles.empty}>
              <Text variant="small" muted>
                {emptyText}
              </Text>
            </View>
          )}
          {tasks.map((task, index) => (
            <TaskRow
              key={task.id}
              task={task}
              owner={teammates.find((teammate) => teammate.id === task.ownerTeammateId)}
              yourName={yourName}
              blocker={blockerOf(task)}
              first={index === 0}
              compact
            />
          ))}
          <Pressable
            onPress={() => {
              haptics.tap();
              router.push(newTaskHref(addFor));
            }}
            accessibilityRole="button"
            android_ripple={{ color: colors.muted }}
            style={[
              styles.add,
              tasks.length > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
              },
            ]}
            testID={testID ? `${testID}-add` : undefined}
          >
            <View style={styles.addIcon}>
              <Plus size={18} color={colors.mutedForeground} />
            </View>
            <Text variant="label" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {addLabel}
            </Text>
          </Pressable>
        </Card>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { paddingHorizontal: space(4), paddingTop: space(3.5), paddingBottom: space(1) },
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: 52,
    paddingHorizontal: space(4),
  },
  // The plus sits where a task's status mark does, so the words line up with titles.
  addIcon: { width: 18, alignItems: "center" },
});
