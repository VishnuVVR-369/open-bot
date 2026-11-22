import type { TaskView } from "@open-bot/api";
import { router, useLocalSearchParams } from "expo-router";
import { ListTodo } from "lucide-react-native";
import { useRef } from "react";
import { LoadError, Loading, NotFound } from "@/components/states";
import { useTasks } from "../hooks";
import { TASKS_HREF } from "../tasks";
import { TaskEditor } from "./task-editor";

/**
 * One task, to read and edit. It stays open if it's deleted meanwhile, saying so, so whatever
 * you were writing isn't snatched away.
 */
export default function TaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const tasks = useTasks();
  const found = tasks.data?.find((task) => task.id === taskId);
  const seen = useRef<TaskView | undefined>(undefined);
  if (found) seen.current = found;
  const task = found ?? seen.current;

  if (tasks.isLoading) return <Loading />;
  if (!task && tasks.error)
    return (
      <LoadError
        title="Couldn't load this task"
        error={tasks.error}
        onRetry={() => void tasks.refetch()}
        onBack={() => (router.canGoBack() ? router.back() : router.replace(TASKS_HREF))}
      />
    );
  if (!task)
    return (
      <NotFound
        icon={ListTodo}
        title="This task is gone"
        body="It may have been deleted or finished a while ago, or the link may be wrong."
        action="Go to Tasks"
        onAction={() => router.replace(TASKS_HREF)}
      />
    );
  return <TaskEditor key={task.id} task={task} gone={!found && Boolean(tasks.data)} />;
}
