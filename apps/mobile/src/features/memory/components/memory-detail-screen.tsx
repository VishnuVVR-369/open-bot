import type { MemoryItem } from "@open-bot/domain";
import { router, useLocalSearchParams } from "expo-router";
import { Brain } from "lucide-react-native";
import { useRef } from "react";
import { LoadError, Loading, NotFound } from "@/components/states";
import { taskScreenState } from "@/features/tasks/tasks";
import { isNotFound } from "@/lib/errors";
import { useMemory } from "../hooks";
import { memoryListHref, saveNote } from "../memory";
import { MemoryEditor } from "./memory-editor";

/**
 * One memory, to read and edit, read on its own so a link or an old one opens too. It stays open
 * if it's forgotten meanwhile, saying so, so whatever you were writing isn't snatched away.
 */
export default function MemoryDetailScreen() {
  const { memoryId, saved } = useLocalSearchParams<{ memoryId: string; saved?: string }>();
  const read = useMemory(memoryId);
  const seen = useRef<MemoryItem | undefined>(undefined);
  if (read.data) seen.current = read.data;
  // The same rule as a task's screen: only the server saying it's gone counts as forgotten.
  const state = taskScreenState(read, seen.current, isNotFound);

  if (state.kind === "loading") return <Loading />;
  if (state.kind === "error")
    return (
      <LoadError
        title="Couldn't load this memory"
        error={read.error}
        onRetry={() => void read.refetch()}
        onBack={() => (router.canGoBack() ? router.back() : router.replace(memoryListHref()))}
      />
    );
  if (state.kind === "missing")
    return (
      <NotFound
        icon={Brain}
        title="This memory is gone"
        body="It may have been forgotten, or the link may be wrong."
        action="Go to Memory"
        onAction={() => router.replace(memoryListHref())}
      />
    );
  return (
    <MemoryEditor
      key={state.task.id}
      item={state.task}
      gone={state.gone}
      note={saveNote(saved)}
      reload={async () => (await read.refetch()).data}
    />
  );
}
