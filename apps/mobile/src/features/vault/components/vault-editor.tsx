import type { VaultItemView } from "@open-bot/api";
import {
  rebaseVaultForm,
  VAULT_COPY,
  VAULT_NAME_MAX,
  vaultChange,
  vaultEditorTitle,
  vaultForm,
  vaultFormChanged,
  vaultFormProblem,
  vaultSaveLabel,
  vaultSecretInput,
  withoutSecrets,
  type VaultDraft,
  type VaultForm,
  type VaultKind,
} from "@open-bot/domain";
import { safe } from "@orpc/client";
import { router, Stack, useNavigation, usePreventRemove } from "expo-router";
import { CloudOff, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { useTeammates } from "@/features/teammates/hooks";
import { api } from "@/lib/api";
import { errorMessage, isGone, isRetryable } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";
import { confirmRemove, refreshVault } from "../actions";
import { vaultLock } from "../hooks";
import { editorReturnsToVault, usedText, VAULT_HREF } from "../vault";
import { AccessPicker, CardFields, Field, LoginFields } from "./vault-fields";
import { useVaultOpen } from "./vault-gate";

/**
 * Adds a login or card, or edits one. An edit sends only what you changed (`vault.patch`), so a
 * change made on the web meanwhile stays, and what you haven't touched follows the item as it
 * changes elsewhere. Secrets are never sent back: their fields start empty, and an empty one keeps
 * what's saved. What you type stays in this screen alone, never in a cache or a draft, and is
 * gone when you leave; leaving with changes asks first. Nothing is sent offline.
 */
export function VaultEditor({
  kind,
  item,
  gone: deleted = false,
}: {
  kind: VaultKind;
  /** The item as last read, or null for a new one. */
  item: VaultItemView | null;
  /** It was deleted while open here. */
  gone?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const open = useVaultOpen();
  const navigation = useNavigation();
  const { data: teammates = [] } = useTeammates();
  const [draft, setDraft] = useState<VaultDraft>(() => {
    const start = vaultForm(item);
    return { start, form: start };
  });
  const { start, form } = draft;
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [goneHere, setGoneHere] = useState(false);
  const [footer, setFooter] = useState(0);
  const [leave, setLeave] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const editing = item !== null;
  const gone = deleted || goneHere;
  const changed = vaultFormChanged(start, form);
  const invalid = vaultFormProblem(kind, form, editing);
  const editable = open && busy === null && !gone;

  // A fresher copy (changed on the web, say): what you haven't touched follows it. Not while a
  // save is on its way: the form is frozen, and the save's own answer comes next.
  useEffect(() => {
    if (item && busy === null) setDraft((current) => rebaseVaultForm(current, vaultForm(item)));
  }, [item, busy]);

  // Back to the vault once it's saved or deleted, after the guard below has let go: back when the
  // vault is under the editor, or in the editor's place when it was opened from a link or search.
  useEffect(() => {
    if (!leave || !navigation.isFocused()) return;
    const { routes, index } = navigation.getState() ?? { routes: [], index: 0 };
    if (editorReturnsToVault(routes[index - 1])) router.back();
    else router.replace(VAULT_HREF);
  }, [leave, navigation]);

  // Discard lets go of the guard and goes on with the leaving it held: `repeat`, since that same
  // leaving dispatched again would be held again.
  usePreventRemove(changed && !leave && !gone && !discarded, ({ repeat }) =>
    Alert.alert("Discard your changes?", `What you typed here isn't saved.`, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          setDiscarded(true);
          repeat();
        },
      },
    ]),
  );

  const set = (patch: Partial<VaultForm>) => {
    if (!editable) return;
    setProblem(null);
    setLost(false);
    setDraft((current) => ({ ...current, form: { ...current.form, ...patch } }));
  };

  async function save() {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    // The vault locked between the tap and now: nothing goes out until it's open again.
    if (!vaultLock.isOpen()) return;
    const change = item ? vaultChange(kind, start, form) : null;
    if (item && !change) return;
    setBusy("save");
    setProblem(null);
    const result = await safe(
      item
        ? api.vault.patch({ itemId: item.id, ...change })
        : api.vault.save({
            id: null,
            kind,
            name: form.name.trim(),
            domain: form.domain,
            teammateIds: form.teammateIds,
            secret: vaultSecretInput(kind, form),
          }),
    );
    void refreshVault();
    setBusy(null);
    if (result.error) {
      haptics.error();
      if (isGone(result.error)) return setGoneHere(true);
      // No answer: a new item may have been saved, and a second try could add it twice.
      setLost(!item && isRetryable(result.error));
      setProblem(errorMessage(result.error, "Couldn't save it."));
      return;
    }
    haptics.success();
    // Saved: what was typed goes from memory now, not when the screen closes.
    const kept = withoutSecrets(form);
    setDraft({ start: kept, form: kept });
    setLeave(true);
  }

  function remove() {
    if (!item) return;
    confirmRemove(item, () => {
      setBusy("delete");
      setLeave(true);
    });
  }

  const noun = kind === "login" ? "login" : "card";
  const canSave = online && open && busy === null && !gone && !invalid && (!editing || changed);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: vaultEditorTitle(kind, item?.name ?? null) }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="vault-editor"
      >
        {gone && (
          <View style={[styles.notice, { backgroundColor: colors.subtle }]} testID="vault-gone">
            <Text variant="small" muted>
              This {noun} was deleted, so changes here can't be saved.
            </Text>
          </View>
        )}
        <Text variant="small" muted style={styles.inset}>
          {kind === "login" ? VAULT_COPY.loginDialog : VAULT_COPY.cardDialog}
          {item ? ` ${usedText(item)}.` : ""}
        </Text>
        <Field label="Name">
          <TextField
            value={form.name}
            onChangeText={(name) => set({ name })}
            editable={editable}
            placeholder={kind === "login" ? "GitHub" : "Personal Visa"}
            maxLength={VAULT_NAME_MAX}
            autoCorrect={false}
            importantForAutofill="no"
            autoFocus={!item}
            testID="vault-name-input"
          />
        </Field>
        {kind === "login" ? (
          <LoginFields form={form} set={set} editable={editable} editing={editing} />
        ) : (
          <CardFields
            form={form}
            set={set}
            editable={editable}
            editing={editing}
            hint={item?.hint ?? null}
          />
        )}
        <Field label="Who can use it">
          <AccessPicker
            value={form.teammateIds}
            onChange={(teammateIds) => set({ teammateIds })}
            teammates={teammates}
            disabled={!editable}
          />
        </Field>
        {item && !gone && (
          <Button
            title={`Delete ${noun}`}
            variant="destructive"
            icon={<Trash2 size={18} color={colors.destructive} />}
            disabled={!online || !open || busy !== null}
            busy={busy === "delete"}
            onPress={remove}
            testID="vault-delete"
          />
        )}
      </ScrollView>

      <View
        onLayout={(event) => setFooter(event.nativeEvent.layout.height)}
        style={[
          styles.footer,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            bottom: keyboard,
            paddingBottom: (keyboard > 0 ? 0 : insets.bottom) + space(3),
          },
        ]}
      >
        {!online ? (
          <View style={styles.offline} testID="vault-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. What you typed stays here until you're back.
            </Text>
          </View>
        ) : lost ? (
          <Text variant="small" muted testID="vault-lost">
            Couldn't tell if it was saved. Check the vault before you try again, so it isn't added
            twice.
          </Text>
        ) : problem ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="vault-problem">
            {problem}
          </Text>
        ) : null}
        <Button
          title={vaultSaveLabel(kind, editing)}
          onPress={() => void save()}
          disabled={!canSave}
          busy={busy === "save"}
          testID="vault-save"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  notice: { borderRadius: 12, padding: space(3) },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: space(4),
    paddingTop: space(3),
    gap: space(2.5),
  },
  offline: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
