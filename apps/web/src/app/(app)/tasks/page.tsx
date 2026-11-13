import type { Metadata } from "next";
import { Page } from "@/components/page";
import { NewTaskButton, TaskBoard } from "@/features/tasks";

export const metadata: Metadata = { title: "Tasks" };

export default function TasksPage() {
  return (
    <Page
      title="Tasks"
      description="What the team is working on. Assign a task, or give your chief of staff a goal."
      actions={<NewTaskButton />}
      width="wide"
    >
      <TaskBoard />
    </Page>
  );
}
