import type { TeammateSummary, MessageView } from "@open-bot/api";
import {
  insertMention,
  mentionedIds,
  mentionOptions,
  mentionQuery,
  sendAttempt,
  type SendAttempt,
} from "@open-bot/chat-core";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { ArrowUp, Mic, Plus, Square } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
} from "react-native";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { useDictation } from "@/features/chat/dictation";
import { nameMentions, onKeptDraft, readDraft, writeDraft } from "@/features/chat/drafts";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useAttachments } from "@/features/chat/use-attachments";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { AttachSheet } from "./attach-sheet";
import { AttachmentChip } from "./attachment-chip";
import { MentionMenu } from "./mention-menu";

/**
 * Where you write to a teammate: text (Markdown), dictation, files and photos, and @mentions in
 * a group. Each message gets an id when you first send it, and a retry of the same message reuses
 * it, so a send that timed out but arrived isn't delivered twice. While a teammate is working, an
 * empty box stops them, and what you send joins what they're doing.
 */
export function Composer({
  chatId,
  placeholder,
  members,
  isGroup,
  activeRun,
  canStop = true,
  onSent,
}: {
  chatId: string;
  placeholder: string;
  members: TeammateSummary[];
  isGroup: boolean;
  /** The reply being written right now, which Stop stops. */
  activeRun: { id: string; teammateName: string } | null;
  /**
   * False while the run waits on you (the request itself has Deny) or the computer is offline
   * (stopping needs it), so Stop only shows while they're actually working.
   */
  canStop?: boolean;
  onSent: (message: MessageView) => void;
}) {
  const colors = useColors();
  const input = useRef<TextInputInstance>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedSend = useRef<SendAttempt | null>(null);

  // Teammates the draft is for that it doesn't name yet (a reply kept from a notification knows
  // only their id), until this chat's members are known and their names are written in.
  const pending = useRef<string[]>([]);
  const typed = useRef(text);
  typed.current = text;
  const chat = useRef({ isGroup, members });
  chat.current = { isGroup, members };
  const edit = useCallback(
    (next: string) => {
      // At once, not on the next render: a kept reply can arrive before it.
      typed.current = next;
      setText(next);
      writeDraft(chatId, next, pending.current);
    },
    [chatId],
  );
  /** Shows a draft, with the teammates it's for written in as `@Name`. */
  const show = useCallback(
    (text: string, mentions: string[]) => {
      const named = nameMentions({ text, mentions }, chat.current);
      pending.current = named.pending;
      edit(named.text);
    },
    [edit],
  );

  // What you'd typed here before, unless you've started typing already.
  useEffect(() => {
    let current = true;
    pending.current = [];
    void readDraft(chatId).then((draft) => {
      if (current && draft.text && !typed.current) show(draft.text, draft.mentions);
    });
    return () => {
      current = false;
    };
  }, [chatId, show]);
  // A reply a notification couldn't send, kept while this chat was open: the stored draft is what
  // you'd typed plus that reply; if what's here differs, keep both.
  useEffect(
    () =>
      onKeptDraft(chatId, (draft, added) => {
        const here = typed.current.trimEnd();
        const text = !here || draft.text.startsWith(here) ? draft.text : `${here}\n\n${added}`;
        show(text, [...new Set([...pending.current, ...draft.mentions])]);
      }),
    [chatId, show],
  );
  // The chat's members arrived after its draft: name the teammates it's for now.
  useEffect(() => {
    if (pending.current.length) show(typed.current, pending.current);
  }, [members, show]);

  const dictation = useDictation({
    onText: (spoken) => {
      edit(spoken);
      setCaret(spoken.length);
    },
    onError: setError,
  });

  const cancelDictation = dictation.cancel;
  // A chat can stay mounted under another screen. Stop listening as soon as it loses focus.
  useFocusEffect(useCallback(() => cancelDictation, [cancelDictation]));

  const attaching = useAttachments(chatId, setError);
  const { files, uploading, failed, ready } = attaching;
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const canSend = hasContent && !uploading && !failed && !sending;

  async function send() {
    if (!canSend) return;
    if (dictation.listening) dictation.stop();
    const attachments = ready.map((pending) => pending.attachment!);
    const mentions = isGroup ? mentionedIds(text, members) : [];
    const thisSend = sendAttempt(
      failedSend.current,
      [chatId, text.trim(), attachments, mentions],
      Crypto.randomUUID,
    );
    const { clientId } = thisSend;
    setSending(true);
    setError(null);
    const result = await safe(api.chats.send({ clientId, chatId, text, attachments, mentions }));
    setSending(false);
    if (result.error) {
      failedSend.current = thisSend;
      setError(errorMessage(result.error, "Couldn't send. Try again."));
      return;
    }
    failedSend.current = null;
    haptics.press();
    pending.current = [];
    edit("");
    setCaret(0);
    attaching.clearSent(ready);
    onSent(result.data);
  }

  async function stop() {
    if (!activeRun) return;
    setStopping(true);
    setError(null);
    haptics.warning();
    const result = await safe(api.runs.cancel({ runId: activeRun.id }));
    setStopping(false);
    if (result.error) setError(errorMessage(result.error, "Couldn't stop them."));
  }

  // @mentions: what's being typed after an @, and who it could be.
  const query = isGroup ? mentionQuery(text, caret) : null;
  const options = query !== null ? mentionOptions(members, query) : [];

  const action: "send" | "mic" | "listening" = dictation.listening
    ? "listening"
    : hasContent || uploading || files.length > 0
      ? "send"
      : "mic";
  // Dictation stays at hand while a teammate works; Stop sits beside it.
  const showStop = Boolean(activeRun) && canStop && action === "mic";

  return (
    <View style={{ gap: space(1.5) }}>
      {error && (
        <Text
          variant="small"
          style={{ color: colors.destructive, paddingHorizontal: space(1) }}
          accessibilityRole="alert"
        >
          {error}
        </Text>
      )}
      {options.length > 0 && (
        <MentionMenu
          options={options}
          onPick={(member) => {
            const next = insertMention(text, caret, member);
            edit(next.text);
            setCaret(next.caret);
            input.current?.setSelection(next.caret, next.caret);
          }}
        />
      )}
      {files.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.chips}
        >
          {files.map((pending) => (
            <AttachmentChip
              key={pending.key}
              pending={pending}
              onRemove={() => attaching.remove(pending)}
              onRetry={() => attaching.retry(pending)}
            />
          ))}
        </ScrollView>
      )}
      <View style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.input }]}>
        <Pressable
          onPress={() => setAttachOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Attach"
          android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
          hitSlop={4}
          style={styles.side}
          testID="attach"
        >
          <Plus size={23} color={colors.foreground} />
        </Pressable>
        <TextInput
          ref={input}
          value={text}
          onChangeText={edit}
          onSelectionChange={(event: TextInputSelectionChangeEvent) =>
            setCaret(event.nativeEvent.selection.end)
          }
          placeholder={dictation.listening ? "Listening…" : placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
          style={[styles.input, { color: colors.foreground }]}
          cursorColor={colors.foreground}
          selectionColor={colors.input}
          textAlignVertical="center"
          testID="composer-input"
        />
        {action === "send" ? (
          <Pressable
            onPress={() => void send()}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={uploading ? "Waiting for files to upload" : "Send"}
            style={[
              styles.send,
              { backgroundColor: colors.primary, opacity: canSend || sending ? 1 : 0.35 },
            ]}
            testID="send"
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <ArrowUp size={18} color={colors.primaryForeground} strokeWidth={2.25} />
            )}
          </Pressable>
        ) : (
          <Pressable
            onPress={() => (dictation.listening ? dictation.stop() : void dictation.start(text))}
            accessibilityRole="button"
            accessibilityLabel={dictation.listening ? "Stop dictating" : "Dictate"}
            accessibilityState={{ selected: dictation.listening }}
            style={[
              styles.send,
              dictation.listening && { backgroundColor: mix(colors.live, colors.surface, 0.14) },
            ]}
            testID="dictate"
          >
            <Mic size={21} color={dictation.listening ? colors.live : colors.mutedForeground} />
          </Pressable>
        )}
        {showStop && (
          <Pressable
            onPress={() => void stop()}
            disabled={stopping}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${activeRun?.teammateName ?? "your teammate"}`}
            style={[styles.send, { backgroundColor: colors.primary }]}
            testID="stop-run"
          >
            {stopping ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Square size={13} color={colors.primaryForeground} fill={colors.primaryForeground} />
            )}
          </Pressable>
        )}
      </View>
      <AttachSheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onPick={(source) => {
          setAttachOpen(false);
          void attaching.pick(source);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderRadius: radius.xl + 6,
    paddingLeft: space(1),
    paddingRight: space(1.5),
    paddingVertical: space(1.5),
    gap: space(1),
  },
  side: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 140,
    minHeight: 40,
    paddingTop: 9,
    paddingBottom: 9,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  chips: { gap: space(2), paddingHorizontal: space(0.5) },
});
