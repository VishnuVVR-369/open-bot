import type { TaskView } from "@open-bot/api";
import type { TaskStatus } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { queryClient, queryKeys } from "@/lib/query";
import { deleteQuestion } from "./tasks";

const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks });

/**
 * Moves a task to another column, or to another place in its own, showing it there right away.
 * When the worker turns it down, the board goes back to how it was and says why.
 */
export async function moveTask(task: TaskView, status: TaskStatus, position?: number) {
  const before = queryClient.getQueryData<TaskView[]>(queryKeys.tasks);
  animateLayout();
  queryClient.setQueryData<TaskView[]>(queryKeys.tasks, (current) =>
    current?.map((entry) =>
      entry.id === task.id
        ? {
            ...entry,
            status,
            position: position ?? entry.position,
            completedAt:
              status === entry.status
                ? entry.completedAt
                : status === "done"
                  ? new Date().toISOString()
                  : null,
          }
        : entry,
    ),
  );
  const result = await safe(
    api.tasks.update({ taskId: task.id, status, ...(position !== undefined ? { position } : {}) }),
  );
  if (result.error) {
    if (before) queryClient.setQueryData(queryKeys.tasks, before);
    haptics.error();
    Alert.alert("Couldn't move it", errorMessage(result.error));
  } else haptics.tap();
  void refresh();
}

/**
 * Hands the task to its teammate in their main chat. Returns that chat, or null when it didn't
 * start (and you were told why).
 */
export async function startTask(
  task: Pick<TaskView, "id">,
): Promise<{ chatId: string | null } | null> {
  const result = await safe(api.tasks.start({ taskId: task.id }));
  void refresh();
  if (result.error) {
    haptics.error();
    Alert.alert("Couldn't start it", errorMessage(result.error));
    return null;
  }
  haptics.success();
  void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
  return result.data;
}

/** Asks, then deletes the task. The board has no undo. */
export function confirmDeleteTask(
  task: Pick<TaskView, "id" | "title" | "status" | "ownerTeammateId">,
  ownerName: string | null,
  onDeleted?: () => void,
) {
  haptics.warning();
  const question = deleteQuestion(task, ownerName);
  Alert.alert(question.title, question.body, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const result = await safe(api.tasks.remove({ taskId: task.id }));
        if (result.error) {
          haptics.error();
          Alert.alert("Couldn't delete it", errorMessage(result.error));
          return;
        }
        haptics.success();
        onDeleted?.();
        animateLayout();
        queryClient.setQueryData<TaskView[]>(queryKeys.tasks, (current) =>
          current?.filter((entry) => entry.id !== task.id),
        );
        void refresh();
      },
    },
  ]);
}
