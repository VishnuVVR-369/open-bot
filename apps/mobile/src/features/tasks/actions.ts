import type { TaskView } from "@open-bot/api";
import { sendMove, TaskStartKeys, type TaskPlacement, type TaskStatus } from "@open-bot/domain";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { queryClient, queryKeys } from "@/lib/query";
import { pendingMoves } from "./hooks";
import { deleteQuestion } from "./tasks";

const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.allTasks });

/** The id of each ask to start a task, kept for retries until it goes through. */
const startKeys = new TaskStartKeys(() => Crypto.randomUUID());

/**
 * Moves a task to another column, or to another place in its own, showing it there right away.
 * The worker places it against the whole column in one change. The move is laid over the board
 * the server last sent until a board read after it has it, so a refusal just stops showing it,
 * whether or not reading the board again works, and undoes nothing else (`PendingMoves`).
 */
export async function moveTask(
  task: Pick<TaskView, "id">,
  status: TaskStatus,
  placement: TaskPlacement,
) {
  animateLayout();
  const result = await sendMove(
    pendingMoves,
    { taskId: task.id, status, placement },
    () => safe(api.tasks.move({ taskId: task.id, status, placement })),
    (answer) => !answer.error,
    refresh,
  );
  if (result.error) {
    animateLayout();
    haptics.error();
    Alert.alert("Couldn't move it", errorMessage(result.error));
  } else haptics.tap();
}

/**
 * Asks the task's owner to start on it, as you saw it: if the task was given to someone else
 * meanwhile, it's refused and you're told who has it. A retry after a failure sends the same
 * start id, so an ask whose answer was lost isn't sent twice. Returns the chat it was asked in,
 * or null when it didn't start (and you were told why).
 */
export async function startTask(
  task: Pick<TaskView, "id">,
  ownerTeammateId: string,
): Promise<{ chatId: string | null } | null> {
  const startId = startKeys.for(task.id, ownerTeammateId);
  const result = await safe(
    api.tasks.start({ taskId: task.id, startId, expectedOwnerId: ownerTeammateId }),
  );
  void refresh();
  if (result.error) {
    haptics.error();
    Alert.alert("Couldn't start it", errorMessage(result.error));
    return null;
  }
  startKeys.done(task.id, ownerTeammateId);
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
