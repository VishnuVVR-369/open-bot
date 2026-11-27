import { forgetMemoryQuestion, type MemoryItem } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage, isStateConflict } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { onlineNow } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";

/** Reads every memory list, memory and history again. */
export const refreshMemory = () => queryClient.invalidateQueries({ queryKey: queryKeys.allMemory });

/** What a write refused because the phone is offline says first. */
export const OFFLINE_TITLE = "You're offline";

/** What to tell you when a change was refused, saying a conflict plainly. */
export const CHANGED_SINCE = "Changed since you opened it.";

/** The result of a change to a memory: done, refused because it changed since, or failed. */
export type MemoryChange<T> =
  { ok: true; data: T } | { ok: false; conflict: boolean; message: string };

/** Sends a change to a memory you saw at a revision, then reads memory again either way. */
async function change<T>(send: () => Promise<T>, fallback: string): Promise<MemoryChange<T>> {
  const result = await safe(send());
  void refreshMemory();
  if (!result.error) {
    haptics.success();
    return { ok: true, data: result.data };
  }
  haptics.error();
  const conflict = isStateConflict(result.error);
  return {
    ok: false,
    conflict,
    message: conflict ? CHANGED_SINCE : errorMessage(result.error, fallback),
  };
}

/** Makes a teammate's suggested memory a real one, as you saw it. */
export const confirmMemory = (item: Pick<MemoryItem, "id" | "revision">) =>
  change(
    () => api.memory.confirm({ id: item.id, expectedRevision: item.revision }),
    "Couldn't confirm it.",
  );

/** Makes an earlier revision the current one, as a new revision; `item` is what you saw. */
export const restoreRevision = (item: Pick<MemoryItem, "id" | "revision">, revision: number) =>
  change(
    () => api.memory.restore({ id: item.id, expectedRevision: item.revision, revision }),
    "Couldn't restore it.",
  );

/**
 * Asks, then forgets the memory (or dismisses a suggestion) as you saw it: one changed since is
 * refused. Once you've said yes, `onStart` hears it's on its way and `onDone` how it went.
 */
export function confirmForget(
  item: Pick<MemoryItem, "id" | "revision" | "state">,
  {
    onStart,
    onDone,
  }: { onStart: () => void; onDone: (result: MemoryChange<{ ok: true }>) => void },
) {
  haptics.warning();
  const question = forgetMemoryQuestion(item);
  Alert.alert(question.title, question.body, [
    { text: "Cancel", style: "cancel" },
    {
      text: question.action,
      style: "destructive",
      onPress: async () => {
        // The connection may have dropped while the question was open: send nothing offline.
        if (!(await onlineNow())) {
          haptics.error();
          Alert.alert(OFFLINE_TITLE, "Nothing was forgotten. Try again once you're back.");
          return;
        }
        onStart();
        onDone(
          await change(
            () => api.memory.forget({ id: item.id, expectedRevision: item.revision }),
            "Couldn't forget it.",
          ),
        );
      },
    },
  ]);
}
