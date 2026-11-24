import {
  boardColumns,
  DONE_SHOWN,
  filterCounts,
  TASK_STATUS_LABELS,
  type TaskFilter,
  type TaskStatus,
} from "@open-bot/domain";
import { router, Stack } from "expo-router";
import { ChevronDown, ListTodo, Plus } from "lucide-react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { FilterChips } from "@/components/filter-chips";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { ConnectionNotice } from "@/features/computer/components/connection-notice";
import { HeaderButton } from "@/features/home/components/header-actions";
import { useTeammates } from "@/features/teammates/hooks";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { useTaskBlockers, useTasks, useYourName } from "../hooks";
import { newTaskHref, taskById } from "../tasks";
import { TaskMenu } from "./task-menu";
import { statusColor } from "./task-parts";
import { TaskRow } from "./task-row";

const EMPTY_TEXT: Record<TaskStatus, string> = {
  todo: "Nothing to do.",
  doing: "Nothing in progress.",
  done: "Nothing finished yet.",
};

/**
 * The team's task board, as the web shows it: To do, Doing and Done, what waits on you first in
 * each. On a phone the columns stack, and holding a task moves it.
 */
export default function TasksScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const tasks = useTasks();
  const teammates = useTeammates();
  const blockerOf = useTaskBlockers();
  const yourName = useYourName();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [showAllDone, setShowAllDone] = useState(false);
  // The held task's id: the menu shows that task as the board has it now, never a copy from when
  // it opened, and closes if it's deleted meanwhile.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const { refreshing, onRefresh } = usePullToRefresh(() =>
    Promise.all([tasks.refetch(), teammates.refetch()]),
  );
  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const allTeammates = teammates.data ?? [];
  const counts = useMemo(() => filterCounts(all, blockerOf), [all, blockerOf]);
  const columns = useMemo(() => boardColumns(all, blockerOf, filter), [all, blockerOf, filter]);
  const sections = useMemo(
    () =>
      columns.map((column) => ({
        status: column.status,
        total: column.tasks.length,
        data:
          column.status === "done" && !showAllDone
            ? column.tasks.slice(0, DONE_SHOWN)
            : column.tasks,
      })),
    [columns, showAllDone],
  );

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <HeaderButton
            label="New task"
            onPress={() => {
              haptics.tap();
              router.push(newTaskHref());
            }}
            testID="new-task"
          >
            <Plus size={24} color={colors.foreground} />
          </HeaderButton>
        ),
      }}
    />
  );

  if (tasks.isLoading) return <Loading />;
  if (tasks.error && !tasks.data)
    return <LoadError error={tasks.error} onRetry={() => void tasks.refetch()} />;
  if (all.length === 0)
    return (
      <>
        {header}
        <Empty
          icon={<ListTodo size={28} color={colors.mutedForeground} />}
          title="Nothing on the board"
          body="Add what needs doing, or give a goal to your lead and they'll fill the board."
          action={
            <Button
              title="New task"
              icon={<Plus size={18} color={colors.primaryForeground} />}
              onPress={() => router.push(newTaskHref())}
              testID="empty-new-task"
            />
          }
        />
      </>
    );

  return (
    <View style={{ flex: 1 }}>
      {header}
      <SectionList
        sections={sections}
        keyExtractor={(task) => task.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListHeaderComponent={
          <View style={styles.top}>
            <ConnectionNotice />
            <FilterChips
              options={[
                { key: "all", label: "All" },
                { key: "mine", label: `Mine (${counts.mine})` },
                {
                  key: "attention",
                  label:
                    counts.attention > 0
                      ? `Needs attention (${counts.attention})`
                      : "Needs attention",
                },
              ]}
              value={filter}
              onChange={setFilter}
            />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View
            style={styles.sectionHead}
            accessibilityRole="header"
            testID={`column-${section.status}`}
          >
            <View
              style={[styles.light, { backgroundColor: statusColor(section.status, colors) }]}
            />
            <Text variant="section">{TASK_STATUS_LABELS[section.status]}</Text>
            <View style={[styles.count, { backgroundColor: colors.subtle }]}>
              <Text variant="caption" muted style={styles.countText}>
                {section.total}
              </Text>
            </View>
          </View>
        )}
        renderItem={({ item: task, index, section }) => (
          <View
            style={[
              styles.cell,
              { backgroundColor: colors.surface, borderColor: colors.border },
              index === 0 && styles.firstCell,
              index === section.data.length - 1 && styles.lastCell,
            ]}
          >
            <TaskRow
              task={task}
              owner={allTeammates.find((teammate) => teammate.id === task.ownerTeammateId)}
              yourName={yourName}
              blocker={blockerOf(task)}
              first={index === 0}
              onMenu={() => setMenuFor(task.id)}
            />
          </View>
        )}
        renderSectionFooter={({ section }) => (
          <View style={styles.sectionFoot}>
            {section.total === 0 && (
              <View style={[styles.empty, { borderColor: colors.input }]}>
                <Text variant="small" muted>
                  {filter === "all" ? EMPTY_TEXT[section.status] : "Nothing here."}
                </Text>
              </View>
            )}
            {section.status === "done" && section.total > DONE_SHOWN && (
              <Quiet
                icon={
                  <ChevronDown
                    size={16}
                    color={colors.mutedForeground}
                    style={showAllDone ? { transform: [{ rotate: "180deg" }] } : undefined}
                  />
                }
                label={
                  showAllDone ? "Show fewer" : `Show ${section.total - DONE_SHOWN} more completed`
                }
                onPress={() => {
                  animateLayout();
                  setShowAllDone((value) => !value);
                }}
                testID="show-done"
              />
            )}
            {/* A task added here is yours, so it shows under All and Mine. */}
            {section.status === "todo" && filter !== "attention" && (
              <Quiet
                icon={<Plus size={16} color={colors.mutedForeground} />}
                label="Add a task"
                onPress={() => router.push(newTaskHref())}
                testID="add-task"
              />
            )}
          </View>
        )}
        testID="tasks"
      />
      <TaskMenu
        task={taskById(all, menuFor)}
        columns={columns}
        blockerOf={blockerOf}
        teammates={allTeammates}
        onClose={() => setMenuFor(null)}
      />
    </View>
  );
}

/** A quiet action under a column, like the web's "Add a task". */
function Quiet({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      android_ripple={{ color: colors.muted }}
      style={styles.quiet}
      testID={testID}
    >
      {icon}
      {/* One line, like the button's label: Android measures it a little narrower than it draws
          it, and the wrapped word ("Add a task") fell outside the row. */}
      <Text variant="small" muted numberOfLines={1} style={{ fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space(4) },
  // The chips bring their own side padding; the list's is taken back so they line up.
  top: { marginHorizontal: -space(4), gap: space(1) },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(1),
    paddingTop: space(5),
    paddingBottom: space(2.5),
  },
  light: { width: 8, height: 8, borderRadius: 4 },
  count: {
    marginLeft: "auto",
    minWidth: 24,
    paddingHorizontal: space(2),
    borderRadius: radius.full,
    alignItems: "center",
  },
  countText: { fontWeight: "500", fontVariant: ["tabular-nums"], lineHeight: 20 },
  // A column is one card, drawn a row at a time so it stays virtualized.
  cell: { borderLeftWidth: 1, borderRightWidth: 1, overflow: "hidden" },
  firstCell: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  lastCell: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  sectionFoot: { gap: space(1), paddingTop: space(1) },
  empty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: radius.xl,
    paddingVertical: space(5),
    alignItems: "center",
  },
  quiet: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    minHeight: 44,
    paddingHorizontal: space(2),
    borderRadius: radius.lg,
    overflow: "hidden",
  },
});
