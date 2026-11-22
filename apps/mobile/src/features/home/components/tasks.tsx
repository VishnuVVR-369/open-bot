import type { TaskView, TeammateSummary } from "@open-bot/api";
import { useMemo } from "react";
import { TaskSection } from "@/features/tasks/components/task-section";
import { useTaskBlockers } from "@/features/tasks/hooks";
import { homeTasks } from "@/features/tasks/tasks";

/** How many tasks Home shows. */
const TASKS_ON_HOME = 3;

/** The board's open tasks that matter most now, with the way to the whole board. */
export function HomeTasks({
  tasks,
  teammates,
}: {
  tasks: readonly TaskView[];
  teammates: readonly TeammateSummary[];
}) {
  const blockerOf = useTaskBlockers();
  const shown = useMemo(() => homeTasks(tasks, blockerOf, TASKS_ON_HOME), [tasks, blockerOf]);
  const open = tasks.filter((task) => task.status !== "done").length;
  return (
    <TaskSection
      tasks={shown}
      teammates={teammates}
      seeAllLabel={open > TASKS_ON_HOME ? `All ${open} open` : "Board"}
      addLabel="Add a task"
      emptyText="Nothing open on the board."
      testID="home-tasks"
    />
  );
}
