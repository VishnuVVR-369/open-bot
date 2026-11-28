import { useLocalSearchParams } from "expo-router";
import { isVaultKind } from "../vault";
import { VaultEditor } from "./vault-editor";
import { VaultGate } from "./vault-gate";

/** A new login (`?kind=login`, the default) or card (`?kind=card`). */
export default function NewVaultItemScreen() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return (
    <VaultGate>
      <VaultEditor kind={isVaultKind(kind) ? kind : "login"} item={null} />
    </VaultGate>
  );
}
