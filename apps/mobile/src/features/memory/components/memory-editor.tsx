import { isSuggestion, MEMORY_CONTENT_MAX, type MemoryItem } from "@open-bot/domain";
import { safe } from "@orpc/client";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { router, Stack, useNavigation, usePreventRemove } from "expo-router";
import { CloudOff, Copy, History, MessageSquare, Trash2 } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { ListRow } from "@/components/list-row";
import { Card } from "@/components/section";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { useTeammates } from "@/features/teammates/hooks";
import { api } from "@/lib/api";
import { errorMessage, isRetryable, isStateConflict } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";
import { CHANGED_SINCE, confirmForget, confirmMemory, refreshMemory } from "../actions";
import {
  afterReload,
  changedSince,
  followMemory,
  leaveQuestion,
  memoryCreate,
  memoryDraft,
  memoryFormChanged,
  memoryFormProblem,
  memoryHistoryHref,
  memoryHref,
  memoryInput,
  memoryMeta,
  type MemoryCreate,
  type MemoryForm,
  type MemoryReload,
} from "../memory";
import { MemoryOptions, SuggestionCard } from "./memory-cards";
import { Field, KindPicker, Notice } from "./memory-parts";

/**
 * A new memory, or one to read and edit: what it says, its type, and whether teammates always get
 * it. A suggestion can be confirmed or dismissed, a memory forgotten, and its history opened.
 * Every change names the revision you saw, so one made meanwhile is refused and shown, never
 * overwritten. Leaving with changes asks first, and nothing is sent while the phone is offline.
 */
export function MemoryEditor({
  item,
  teammateId = null,
  gone = false,
  note = null,
  reload,
}: {
  /** The memory as last read, or null for a new one. */
  item: MemoryItem | null;
  /** A new memory's teammate, or null for a shared one. */
  teammateId?: string | null;
  /** It was forgotten while open here. */
  gone?: boolean;
  /** What saving it said, when it wasn't just added (it was already saved, say). */
  note?: string | null;
  /** Reads the memory again from the server, for the Reload after a conflict. */
  reload?: () => Promise<MemoryReload>;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const online = useOnline();
  const navigation = useNavigation();
  const { data: teammates = [] } = useTeammates();
  const [draft, setDraft] = useState(() => memoryDraft(item));
  const { base, start, form } = draft;
  const [busy, setBusy] = useState<"save" | "confirm" | "forget" | "reload" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The server refused a change because the memory changed meanwhile.
  const [refused, setRefused] = useState(false);
  // A new memory whose save got no answer: the form stays as sent, with its id, until it's settled.
  const [lost, setLost] = useState<MemoryCreate | null>(null);
  // Forgotten here: the screen leaves once it's the one you're looking at.
  const [forgotten, setForgotten] = useState(false);
  const [footer, setFooter] = useState(0);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => leave?.(), [leave]);
  const go = (to: () => void) => setLeave(() => to);

  const locked = busy !== null || lost !== null;
  const changed = memoryFormChanged(start, form);
  const stale = refused || changedSince(draft, item);
  const invalid = memoryFormProblem(form);
  const scope = base ? base.teammateId : teammateId;
  const name = (id: string | null | undefined) =>
    teammates.find((teammate) => teammate.id === id)?.name ?? null;
  const suggestion = base !== null && isSuggestion(base);

  // A fresher copy (changed on the web, by a teammate, or restored): an untouched form follows it.
  useEffect(() => {
    if (item && !locked) setDraft((current) => followMemory(current, item));
  }, [item, locked]);

  // The form moved on to a newer revision, so an earlier refusal no longer holds.
  useEffect(() => setRefused(false), [base?.revision, base?.state]);

  // Forgotten while History or the chat was open on top: leave once you're back, not from there.
  useEffect(() => {
    if (!forgotten) return;
    const open = () =>
      setLeave(() => () => (router.canGoBack() ? router.back() : router.replace("/memory")));
    if (navigation.isFocused()) open();
    return navigation.addListener("focus", open);
  }, [forgotten, navigation]);

  // Even once it's forgotten elsewhere, what you wrote isn't dropped without asking. Discard lets
  // the blocked leave go through with `repeat`: dispatching it again would only be blocked again.
  const [discarding, setDiscarding] = useState(false);
  const question = leaveQuestion(changed, leave !== null || discarding, gone);
  usePreventRemove(question !== null, ({ repeat }) => {
    if (!question) return;
    Alert.alert(question.title, question.body, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          setDiscarding(true);
          repeat();
        },
      },
    ]);
  });

  const set = (patch: Partial<MemoryForm>) => {
    if (locked) return;
    setProblem(null);
    setDraft((current) => ({ ...current, form: { ...current.form, ...patch } }));
  };

  function failed(error: unknown, fallback: string) {
    setBusy(null);
    haptics.error();
    if (isStateConflict(error)) {
      setRefused(true);
      setProblem(null);
    } else setProblem(errorMessage(error, fallback));
  }

  async function save() {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    setBusy("save");
    setProblem(null);
    if (base) {
      const result = await safe(
        api.memory.update({
          ...memoryInput(form, base.teammateId),
          id: base.id,
          expectedRevision: base.revision,
        }),
      );
      void refreshMemory();
      if (result.error) return failed(result.error, "Couldn't save the memory.");
      saved(result.data);
      if (navigation.isFocused()) go(() => router.back());
      return;
    }
    // Sent again unchanged, with the same id, after a lost answer, it can't add a second memory:
    // the server answers with the one the first attempt added, as it is now.
    const request = memoryCreate(lost, form, teammateId, Crypto.randomUUID);
    const result = await safe(api.memory.create({ ...request.input, id: request.id }));
    void refreshMemory();
    if (result.error) {
      // No answer, so it may have been added: keep it as sent. A refusal added nothing, or says
      // what became of it (forgotten since), and a new try is a new save.
      setLost(isRetryable(result.error) ? request : null);
      setBusy(null);
      haptics.error();
      setProblem(errorMessage(result.error, "Couldn't save the memory."));
      return;
    }
    const outcome = result.data.saveOutcome;
    setLost(null);
    saved(result.data);
    if (!navigation.isFocused()) return;
    if (outcome === "created") go(() => router.back());
    else go(() => router.replace(memoryHref(result.data.id, outcome)));
  }

  /** What was sent is saved: the form starts from the memory as it is now. */
  function saved(memory: MemoryItem) {
    queryClient.setQueryData(queryKeys.memory(memory.id), memory);
    setDraft(memoryDraft(memory));
    setBusy(null);
    setRefused(false);
    haptics.success();
  }

  async function confirm() {
    if (!base) return;
    setBusy("confirm");
    setProblem(null);
    const result = await confirmMemory(base);
    if (result.ok) return saved(result.data);
    setBusy(null);
    if (result.conflict) setRefused(true);
    else setProblem(result.message);
  }

  function forget() {
    if (!base) return;
    confirmForget(base, {
      onStart: () => {
        setBusy("forget");
        setProblem(null);
      },
      onDone: (result) => {
        setBusy(null);
        if (result.ok) setForgotten(true);
        else if (result.conflict) setRefused(true);
        else setProblem(result.message);
      },
    });
  }

  /** Reload after a conflict: only a fresh read from the server replaces what you wrote. */
  async function reloadSaved() {
    if (!reload) return;
    haptics.tap();
    setBusy("reload");
    setProblem(null);
    const next = afterReload(draft, await reload());
    setBusy(null);
    setDraft(next.draft);
    setRefused(next.refused);
    setProblem(next.problem);
    if (next.problem) haptics.error();
  }

  async function copyDraft() {
    await Clipboard.setStringAsync(form.content);
    haptics.success();
  }

  const writable = online && !gone && !stale && !forgotten;
  const canSave = writable && !invalid && busy === null && (base === null || changed);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{ title: base ? (suggestion ? "Suggestion" : "Memory") : "New memory" }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: footer + space(6) }]}
        testID="memory-editor"
      >
        {gone && (
          <Notice
            testID="memory-gone"
            stacked
            action={
              changed && form.content.trim() ? (
                <Button
                  title="Copy what you wrote"
                  variant="outline"
                  icon={<Copy size={16} color={colors.foreground} />}
                  onPress={() => void copyDraft()}
                  testID="memory-copy-draft"
                />
              ) : undefined
            }
          >
            This memory was forgotten, so changes here can't be saved.
          </Notice>
        )}
        {stale && !gone && (
          <Notice
            tone="attention"
            testID="memory-conflict"
            action={
              <Button
                title="Reload"
                variant="outline"
                onPress={() => void reloadSaved()}
                disabled={busy !== null || !online || !reload}
                busy={busy === "reload"}
                testID="memory-reload"
              />
            }
          >
            {`${CHANGED_SINCE} Reload to see the saved version${changed ? "; your changes here will be discarded." : "."}`}
          </Notice>
        )}
        {note && <Notice testID="memory-note">{note}</Notice>}
        {suggestion && base && (
          <SuggestionCard
            by={name(base.source.teammateId)}
            busy={busy}
            disabled={!writable || busy !== null}
            changed={changed}
            onConfirm={() => void confirm()}
            onDismiss={forget}
          />
        )}
        <Text variant="small" muted style={styles.inset}>
          {base ? memoryMeta(base, name(base.source.teammateId)).join(" · ") + ". " : ""}
          {scope
            ? `Only ${name(scope) ?? "this teammate"} gets this memory.`
            : "Every teammate can use this memory."}
        </Text>
        <Field label="Memory">
          <TextField
            value={form.content}
            onChangeText={(content) => set({ content })}
            editable={!locked && !gone}
            placeholder="One durable fact or preference"
            maxLength={MEMORY_CONTENT_MAX}
            autoFocus={!base}
            multiline
            style={styles.field}
            testID="memory-content-input"
          />
        </Field>
        <Field label="Type">
          <KindPicker
            value={form.kind}
            onChange={(kind) => set({ kind })}
            disabled={locked || gone}
          />
        </Field>
        <MemoryOptions form={form} disabled={locked || gone} onChange={set} />
        {base && (
          <Card>
            <ListRow
              leading={<RowIcon icon={<History size={18} color={colors.foreground} />} />}
              title="History"
              subtitle={
                gone
                  ? "Forgotten with the memory."
                  : base.revision > 1
                    ? `${base.revision} revisions. Restore an earlier one.`
                    : "Every change is kept here."
              }
              onPress={() => router.push(memoryHistoryHref(base.id))}
              testID="memory-history"
            />
            {base.source.chatId && (
              <View style={[styles.divided, { borderTopColor: colors.border }]}>
                <ListRow
                  leading={<RowIcon icon={<MessageSquare size={18} color={colors.foreground} />} />}
                  title="See the conversation"
                  subtitle="Where it was saved"
                  onPress={() => router.push(chatHref(base.source.chatId!, base.source.runId))}
                  testID="memory-source-chat"
                />
              </View>
            )}
          </Card>
        )}
        {base && !suggestion && !gone && (
          <Button
            title="Forget memory"
            variant="destructive"
            icon={<Trash2 size={18} color={colors.destructive} />}
            disabled={!writable || busy !== null}
            busy={busy === "forget"}
            onPress={forget}
            testID="memory-forget"
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
          <View style={styles.offline} testID="memory-offline">
            <CloudOff size={14} color={colors.mutedForeground} />
            <Text variant="caption" muted style={{ flex: 1 }}>
              You're offline. Your changes stay here until you're back.
            </Text>
          </View>
        ) : lost ? (
          <Text variant="small" muted testID="memory-lost">
            Couldn't tell if it was saved. Try again: it won't be added twice.
          </Text>
        ) : problem ? (
          <Text variant="small" style={{ color: colors.destructive }} testID="memory-problem">
            {problem}
          </Text>
        ) : null}
        <Button
          title={lost ? "Try again" : base ? "Save" : "Add memory"}
          onPress={() => void save()}
          disabled={!canSave}
          busy={busy === "save"}
          testID="memory-save"
        />
      </View>
    </View>
  );
}

function RowIcon({ icon }: { icon: ReactNode }) {
  const colors = useColors();
  return <View style={[styles.icon, { backgroundColor: colors.subtle }]}>{icon}</View>;
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(5) },
  inset: { paddingHorizontal: space(1) },
  field: { minHeight: 140 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
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
