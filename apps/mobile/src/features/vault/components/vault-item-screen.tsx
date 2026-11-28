import type { VaultItemView } from "@open-bot/api";
import { router, useLocalSearchParams } from "expo-router";
import { KeyRound } from "lucide-react-native";
import { useEffect, useState } from "react";
import { LoadError, Loading, NotFound } from "@/components/states";
import { useVaultItems } from "../hooks";
import { VAULT_HREF } from "../vault";
import { VaultEditor } from "./vault-editor";
import { VaultGate } from "./vault-gate";

/** A saved login or card, to edit or delete, behind your fingerprint. */
export default function VaultItemScreen() {
  return (
    <VaultGate>
      <VaultItem />
    </VaultGate>
  );
}

function VaultItem() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const items = useVaultItems();
  const item = items.data?.find((entry) => entry.id === itemId);
  // Once open, the editor stays: it says itself when the item is deleted meanwhile.
  const [opened, setOpened] = useState<VaultItemView | null>(null);
  useEffect(() => {
    if (item && !opened) setOpened(item);
  }, [item, opened]);
  const gone = items.data !== undefined && !item;

  if (gone && !opened)
    return (
      <NotFound
        icon={KeyRound}
        title="This item is gone"
        body="It was deleted, or the link is wrong."
        action="See the vault"
        onAction={() => router.replace(VAULT_HREF)}
      />
    );
  if (items.isLoading || (item && !opened)) return <Loading />;
  if (!opened)
    return (
      <LoadError
        title="Couldn't open it"
        error={items.error}
        onRetry={() => void items.refetch()}
      />
    );
  return <VaultEditor kind={opened.kind} item={item ?? opened} gone={gone} />;
}
