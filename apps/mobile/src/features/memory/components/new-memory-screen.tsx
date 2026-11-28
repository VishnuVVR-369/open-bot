import { useLocalSearchParams } from "expo-router";
import { MemoryEditor } from "./memory-editor";

/** A new memory: one teammate's, from their memory or profile, or a shared one. */
export default function NewMemoryScreen() {
  const { teammateId } = useLocalSearchParams<{ teammateId?: string }>();
  return <MemoryEditor item={null} teammateId={teammateId ?? null} />;
}
