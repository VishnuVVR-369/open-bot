import type { VaultItemView } from "@open-bot/api";
import { deleteVaultItemQuestion } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { Alert } from "react-native";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { onlineNow } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { vaultLock } from "./hooks";
import { removeOptimistically } from "./vault";

export const refreshVault = () => queryClient.invalidateQueries({ queryKey: queryKeys.vault });

/**
 * Asks, then deletes the item. It leaves the list at once (`onStart` hears it's on its way); a
 * delete that fails puts it back and says why. Nothing is sent offline, or once the vault locked.
 */
export function confirmRemove(
  item: Pick<VaultItemView, "id" | "kind" | "name">,
  onStart: () => void,
) {
  haptics.warning();
  const question = deleteVaultItemQuestion(item);
  Alert.alert(question.title, question.body, [
    { text: "Cancel", style: "cancel" },
    {
      text: question.action,
      style: "destructive",
      onPress: async () => {
        if (!vaultLock.isOpen()) return;
        if (!(await onlineNow())) {
          haptics.error();
          Alert.alert("You're offline", "Nothing was deleted. Try again once you're back.");
          return;
        }
        onStart();
        const error = await removeOptimistically(queryClient, queryKeys.vault, item.id, () =>
          safe(api.vault.remove({ itemId: item.id })),
        );
        void refreshVault();
        if (!error) return haptics.success();
        haptics.error();
        Alert.alert(`Couldn't delete ${item.name}`, errorMessage(error, "Try again in a moment."));
      },
    },
  ]);
}
