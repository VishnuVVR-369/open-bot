import type { Metadata } from "next";
import { Page } from "@/components/page";
import { NewTaskButton, TaskBoard } from "@/components/tasks/task-board";

export const metadata: Metadata = { title: "Tasks" };

export default function TasksPage() {
  return (
    <Page
      title="Tasks"
      description="What the team is working on. Give a task to a teammate and ask them to start, or hand a goal to your chief of staff to split up."
      actions={<NewTaskButton />}
      width="wide"
    >
      <TaskBoard />
    </Page>
  );
}
