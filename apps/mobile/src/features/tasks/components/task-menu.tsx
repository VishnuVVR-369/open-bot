import type { TaskView, TeammateSummary } from "@open-bot/api";
import { stepPosition, TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "@open-bot/domain";
import { router } from "expo-router";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  CircleCheck,
  CircleDot,
  MessageSquare,
  Pencil,
  Play,
  Trash2,
} from "lucide-react-native";
import { useRef } from "react";
import { Sheet, SheetItem } from "@/components/sheet";
import { chatHref } from "@/lib/links";
import { useOnline } from "@/lib/network";
import { useColors } from "@/theme";
import { confirmDeleteTask, moveTask, startTask } from "../actions";
import { startLabel, taskHref } from "../tasks";

const STATUS_ICONS = { todo: Circle, doing: CircleDot, done: CircleCheck } as const;

/**
 * What you can do with a task you held: hand it to its teammate, open their chat, move it to
 * another column or one place up or down in its own (the web's drag and drop), edit or delete it.
 * Anything that changes the board waits for a connection.
 */
export function TaskMenu({
  task: open,
  tasks,
  teammates,
  onClose,
}: {
  task: TaskView | null;
  /** The whole board, for where the task can move. */
  tasks: readonly TaskView[];
  teammates: readonly TeammateSummary[];
  onClose: () => void;
}) {
  const colors = useColors();
  const online = useOnline();
  // The task stays in the sheet while it slides away.
  const last = useRef(open);
  if (open) last.current = open;
  const task = open ?? last.current;
  const owner = teammates.find((teammate) => teammate.id === task?.ownerTeammateId);
  const column = task ? tasks.filter((entry) => entry.status === task.status) : [];
  const up = task && task.status !== "done" ? stepPosition(column, task.id, "up") : null;
  const down = task && task.status !== "done" ? stepPosition(column, task.id, "down") : null;
  const icon = (Icon: typeof Circle, color = colors.foreground) => <Icon size={20} color={color} />;
  const act = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Sheet
      open={open !== null}
      onClose={onClose}
      title={task?.title}
      titleLines={2}
      description={online ? undefined : "You're offline. Changes to the board need a connection."}
      testID="task-menu"
    >
      {task && owner && task.status !== "done" && (
        <SheetItem
          icon={icon(Play)}
          label={startLabel(task.status, owner.name)}
          disabled={!online}
          onPress={act(
            () =>
              void startTask(task).then((started) => {
                if (started?.chatId) router.push(chatHref(started.chatId));
              }),
          )}
          testID="task-menu-start"
        />
      )}
      {task?.chatId && owner && (
        <SheetItem
          icon={icon(MessageSquare)}
          label={`Open ${owner.name}'s chat`}
          onPress={act(() => router.push(chatHref(task.chatId!)))}
          testID="task-menu-chat"
        />
      )}
      {task &&
        TASK_STATUSES.filter((status) => status !== task.status).map((status: TaskStatus) => (
          <SheetItem
            key={status}
            icon={icon(STATUS_ICONS[status])}
            label={`Move to ${TASK_STATUS_LABELS[status]}`}
            disabled={!online}
            onPress={act(() => void moveTask(task, status))}
            testID={`task-menu-move-${status}`}
          />
        ))}
      {task && up !== null && (
        <SheetItem
          icon={icon(ArrowUp)}
          label="Move up"
          disabled={!online}
          onPress={act(() => void moveTask(task, task.status, up))}
          testID="task-menu-up"
        />
      )}
      {task && down !== null && (
        <SheetItem
          icon={icon(ArrowDown)}
          label="Move down"
          disabled={!online}
          onPress={act(() => void moveTask(task, task.status, down))}
          testID="task-menu-down"
        />
      )}
      {task && (
        <SheetItem
          icon={icon(Pencil)}
          label="Edit"
          onPress={act(() => router.push(taskHref(task.id)))}
          testID="task-menu-edit"
        />
      )}
      {task && (
        <SheetItem
          icon={icon(Trash2, colors.destructive)}
          label="Delete"
          destructive
          disabled={!online}
          onPress={act(() => confirmDeleteTask(task, owner?.name ?? null))}
          testID="task-menu-delete"
        />
      )}
    </Sheet>
  );
}
