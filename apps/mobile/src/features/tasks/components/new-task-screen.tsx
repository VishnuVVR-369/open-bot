import { useLocalSearchParams } from "expo-router";
import { TaskEditor } from "./task-editor";

/** A new task on the board; from a teammate's profile it's already theirs. */
export default function NewTaskScreen() {
  const { owner } = useLocalSearchParams<{ owner?: string }>();
  return <TaskEditor task={null} owner={owner ?? null} />;
}
