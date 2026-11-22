import type { TaskView } from "@open-bot/api";
import { dueLabel, TASK_NOTES_MAX, TASK_TITLE_MAX } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { router, Stack, useNavigation, usePreventRemove } from "expo-router";
import { CloudOff, MessageSquare, Play, Trash2, X } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { ListRow } from "@/components/list-row";
import { Card } from "@/components/section";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { useTeammates } from "@/features/teammates/hooks";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";
import { confirmDeleteTask, startTask } from "../actions";
import { useYourName } from "../hooks";
import {
  emptyTaskForm,
  newTask,
  ownerName,
  startLabel,
  taskChanges,
  taskForm,
  taskFormChanged,
  taskFormProblem,
  taskHref,
  withAddedTask,
  type TaskForm,
} from "../tasks";
import { DueSheet } from "./due-sheet";
import { OwnerSheet } from "./owner-sheet";
import { StatusPicker } from "./status-picker";
import { YouAvatar } from "./task-parts";

/**
 * A new task, or one to edit: its title and notes, who owns it, when it's due and where it
 * stands. Only what you change is sent, so a teammate's edit meanwhile stays. Leaving with
 * changes asks first, and nothing is sent while the phone is offline: the draft stays here.
 */
export function TaskEditor({
  task,
  owner: initialOwner = null,
  gone: deleted = false,
}: {
  /** Null for a new task. */
  task: TaskView | null;
  /** A new task's owner, when it's added from a teammate's profile. */
  owner?: string | null;
  /** The task was deleted while it was open here. */
  gone?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const navigation = useNavigation();
  const { data: teammates = [] } = useTeammates();
  const yourName = useYourName();
  // Where the form started: what's sent is the difference from it.
  const [start, setStart] = useState<TaskForm>(() =>
    task ? taskForm(task) : emptyTaskForm(initialOwner),
  );
  const [form, setForm] = useState<TaskForm>(start);
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"owner" | "due" | null>(null);
  const [footer, setFooter] = useState(0);
  // Where to go once it's saved, run after the guard below has let go.
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => leave?.(), [leave]);
  const go = (to: () => void) => setLeave(() => to);
  // Deleted here, it's on its way out: no notice while it goes.
  const gone = deleted && !leave;

  const owner = teammates.find((teammate) => teammate.id === form.ownerTeammateId);
  const changed = taskFormChanged(start, form);
  const canStart = Boolean(owner) && form.status !== "done" && !gone;
  const invalid = taskFormProblem(form);
  const set = (patch: Partial<TaskForm>) => {
    setProblem(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  usePreventRemove(changed && !leave && !gone, ({ data }) =>
    Alert.alert("Discard your changes?", "What you changed in this task isn't saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]),
  );

  async function save(then?: "start") {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    setBusy(then ?? "save");
    setProblem(null);
    let id = task?.id;
    if (task) {
      const changes = taskChanges(start, form);
      if (Object.keys(changes).length > 0) {
        const result = await safe(api.tasks.update({ taskId: task.id, ...changes }));
        if (result.error) return failed(result.error);
      }
    } else {
      const result = await safe(api.tasks.create(newTask(form)));
      if (result.error) return failed(result.error);
      const created = result.data.id;
      id = created;
      // On the board at once, so the task screen can open on it before the board comes back.
      queryClient.setQueryData<TaskView[]>(queryKeys.tasks, (board) =>
        board ? withAddedTask(board, created, form) : board,
      );
    }
    setStart(form);
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    if (then !== "start") {
      haptics.success();
      return go(() => router.back());
    }
    const started = await startTask({ id: id! });
    setBusy(null);
    // Saved but not started: a new task opens as itself, so trying again doesn't add it twice.
    if (!started) return task ? undefined : go(() => router.replace(taskHref(id!)));
    go(() => (started.chatId ? router.replace(chatHref(started.chatId)) : router.back()));
  }

  function failed(error: unknown) {
    setBusy(null);
    haptics.error();
    setProblem(errorMessage(error, "Couldn't save the task."));
  }

  const addedBy =
    task?.createdBy === "teammate"
      ? `Added by ${teammates.find((teammate) => teammate.id === task.createdByTeammateId)?.name ?? "a teammate"}.`
      : null;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: task ? "Task" : "New task" }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="task-editor"
      >
        {gone && (
          <View style={[styles.notice, { backgroundColor: colors.subtle }]} testID="task-gone">
            <Text variant="small" muted>
              This task was deleted, so changes here can't be saved.
            </Text>
          </View>
        )}
        {addedBy && (
          <Text variant="small" muted style={styles.inset}>
            {addedBy}
          </Text>
        )}
        <Field label="Title">
          <TextField
            value={form.title}
            onChangeText={(title) => set({ title })}
            placeholder="Book flights to Tokyo"
            maxLength={TASK_TITLE_MAX}
            autoFocus={!task}
            multiline
            submitBehavior="blurAndSubmit"
            returnKeyType="done"
            style={styles.title}
            testID="task-title-input"
          />
        </Field>
        <Field label="Notes">
          <TextField
            value={form.notes}
            onChangeText={(notes) => set({ notes })}
            placeholder="What done looks like, and anything they should know."
            maxLength={TASK_NOTES_MAX}
            multiline
            style={styles.notes}
            testID="task-notes-input"
          />
        </Field>
        <Card>
          <FormRow
            label="Owner"
            onPress={() => setSheet("owner")}
            testID="task-owner"
            value={
              <View style={styles.value}>
                {owner ? (
                  <TeammateAvatar {...owner} size="xs" />
                ) : (
                  <YouAvatar name={yourName} size={22} />
                )}
                <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {ownerName(owner, form.ownerTeammateId)}
                </Text>
              </View>
            }
          />
          <FormRow
            label="Due"
            first={false}
            onPress={() => setSheet("due")}
            testID="task-due-row"
            value={
              <Text
                variant="label"
                style={
                  form.dueOn ? undefined : { color: colors.mutedForeground, fontWeight: "400" }
                }
              >
                {form.dueOn ? dueLabel(form.dueOn) : "No due date"}
              </Text>
            }
            trailing={
              form.dueOn ? (
                <Pressable
                  onPress={() => {
                    haptics.tap();
                    set({ dueOn: null });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Clear the due date"
                  android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
                  style={styles.clear}
                  testID="task-due-clear"
                >
                  <X size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : null
            }
          />
        </Card>
        {task && (
          <Field label="Status">
            <StatusPicker value={form.status} onChange={(status) => set({ status })} />
          </Field>
        )}
        {task?.chatId && owner && (
          <Card>
            <ListRow
              leading={
                <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
                  <MessageSquare size={18} color={colors.foreground} />
                </View>
              }
              title={`${owner.name}'s chat`}
              subtitle="Where they were last asked to work on it"
              onPress={() => router.push(chatHref(task.chatId!))}
              testID="task-chat"
            />
          </Card>
        )}
        {task && !gone && (
          <Button
            title="Delete task"
            variant="destructive"
            icon={<Trash2 size={18} color={colors.destructive} />}
            disabled={!online || busy !== null}
            onPress={() =>
              confirmDeleteTask(task, owner?.name ?? null, () => go(() => router.back()))
            }
            testID="task-delete"
          />
        )}
      </ScrollView>

      <View
        onLayout={(event) => setFooter(event.nativeEvent.layout.height)}
        style={[
          styles.footer,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            bottom: keyboard,
            paddingBottom: (keyboard > 0 ? 0 : insets.bottom) + space(3),
          },
        ]}
      >
        {!online ? (
          <View style={styles.offline} testID="task-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. Your changes stay here until you're back.
            </Text>
          </View>
        ) : problem ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="task-problem">
            {problem}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          {canStart && owner && (
            <Button
              title={startLabel(form.status, owner.name)}
              variant="outline"
              icon={<Play size={16} color={colors.foreground} fill={colors.foreground} />}
              onPress={() => void save("start")}
              disabled={!online || busy !== null || Boolean(invalid)}
              busy={busy === "start"}
              style={{ flex: 1 }}
              testID="task-start"
            />
          )}
          <Button
            title={task ? "Save" : "Add task"}
            onPress={() => void save()}
            disabled={
              !online || busy !== null || Boolean(invalid) || gone || (task !== null && !changed)
            }
            busy={busy === "save"}
            style={canStart ? styles.save : { flex: 1 }}
            testID="task-save"
          />
        </View>
      </View>

      <OwnerSheet
        open={sheet === "owner"}
        value={form.ownerTeammateId}
        teammates={teammates}
        yourName={yourName}
        onPick={(ownerTeammateId) => set({ ownerTeammateId })}
        onClose={() => setSheet(null)}
      />
      <DueSheet
        open={sheet === "due"}
        value={form.dueOn}
        onPick={(dueOn) => set({ dueOn })}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="overline" muted style={styles.inset}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/** A row in the form's card: what it is on the left, its value and a way to change it on the right. */
function FormRow({
  label,
  value,
  trailing,
  onPress,
  first = true,
  testID,
}: {
  label: string;
  value: ReactNode;
  trailing?: ReactNode;
  onPress: () => void;
  first?: boolean;
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
      accessibilityLabel={label}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={testID}
    >
      <Text variant="body" muted style={styles.rowLabel}>
        {label}
      </Text>
      <View style={styles.rowValue}>{value}</View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  notice: { borderRadius: 12, padding: space(3) },
  title: { minHeight: 52 },
  notes: { minHeight: 120 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: 56,
    paddingHorizontal: space(4),
  },
  rowLabel: { width: 72 },
  rowValue: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  value: { flexDirection: "row", alignItems: "center", gap: space(2), flexShrink: 1 },
  clear: {
    width: 36,
    height: 36,
    marginRight: -space(2),
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(4),
    paddingTop: space(3),
    gap: space(2.5),
  },
  offline: { flexDirection: "row", alignItems: "center", gap: space(2) },
  buttons: { flexDirection: "row", gap: space(3) },
  save: { minWidth: 112 },
});
