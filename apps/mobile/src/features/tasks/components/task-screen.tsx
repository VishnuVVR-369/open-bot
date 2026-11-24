import type { TaskView } from "@open-bot/api";
import { router, useLocalSearchParams } from "expo-router";
import { ListTodo } from "lucide-react-native";
import { useRef } from "react";
import { LoadError, Loading, NotFound } from "@/components/states";
import { isNotFound } from "@/lib/errors";
import { useTask } from "../hooks";
import { TASKS_HREF, taskScreenState } from "../tasks";
import { TaskEditor } from "./task-editor";

/**
 * One task, to read and edit, read on its own so a task finished long ago opens too. It stays open
 * if it's deleted meanwhile, saying so, so whatever you were writing isn't snatched away.
 */
export default function TaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const read = useTask(taskId);
  const seen = useRef<TaskView | undefined>(undefined);
  if (read.data) seen.current = read.data;
  const state = taskScreenState(read, seen.current, isNotFound);

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "error")
    return (
      <LoadError
        title="Couldn't load this task"
        error={read.error}
        onRetry={() => void read.refetch()}
        onBack={() => (router.canGoBack() ? router.back() : router.replace(TASKS_HREF))}
      />
    );
  if (state.kind === "missing")
    return (
      <NotFound
        icon={ListTodo}
        title="This task is gone"
        body="It may have been deleted, or the link may be wrong."
        action="Go to Tasks"
        onAction={() => router.replace(TASKS_HREF)}
      />
    );
  return <TaskEditor key={state.task.id} task={state.task} gone={state.gone} />;
}
