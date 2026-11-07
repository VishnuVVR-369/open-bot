import type { Attachment, BotSummary, MessageView } from "@open-bot/api";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect } from "expo-router";
import {
  AlertCircle,
  ArrowUp,
  Camera,
  FileUp,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-react-native";
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
import { BotAvatar } from "@/components/bot-avatar";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { useDictation } from "@/lib/dictation";
import { readDraft, writeDraft } from "@/lib/drafts";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { insertMention, mentionedIds, mentionOptions, mentionQuery } from "@/lib/mentions";
import { cantAttach, type PickedFile } from "@/lib/upload-protocol";
import { uploadAttachment } from "@/lib/uploads";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

const MAX_ATTACHMENTS = 20;

interface Pending {
  key: string;
  file: PickedFile;
  progress: number;
  state: "uploading" | "done" | "failed";
  attachment?: Attachment;
  error?: string;
  controller: AbortController;
}

/** A file being attached: its name, how far along it is, and a way to drop (or retry) it. */
function AttachmentChip({
  pending,
  onRemove,
  onRetry,
}: {
  pending: Pending;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  const failed = pending.state === "failed";
  return (
    <View
      style={[
        styles.chip,
        {
          borderColor: failed ? mix(colors.destructive, colors.surface, 0.5) : colors.border,
          backgroundColor: colors.surface,
        },
      ]}
      testID="attachment"
    >
      {failed ? (
        <AlertCircle size={14} color={colors.destructive} />
      ) : pending.state === "uploading" ? (
        <ActivityIndicator size={12} color={colors.mutedForeground} />
      ) : (
        <Paperclip size={14} color={colors.mutedForeground} />
      )}
      <View style={{ flexShrink: 1 }}>
        <Text variant="small" numberOfLines={1} style={{ fontSize: 13.5 }}>
          {pending.file.name}
        </Text>
        {failed ? (
          <Text variant="caption" numberOfLines={1} style={{ color: colors.destructive }}>
            {pending.error}
          </Text>
        ) : pending.state === "uploading" ? (
          <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {Math.round(pending.progress * 100)}%
          </Text>
        ) : null}
      </View>
      {failed && (
        <Pressable onPress={onRetry} hitSlop={8} accessibilityLabel={`Retry ${pending.file.name}`}>
          <RotateCcw size={14} color={colors.foreground} />
        </Pressable>
      )}
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${pending.file.name}`}
      >
        <X size={15} color={colors.mutedForeground} />
      </Pressable>
      {pending.state === "uploading" && (
        <View style={[styles.progress, { backgroundColor: colors.muted }]}>
          <View
            style={{
              width: `${Math.max(4, pending.progress * 100)}%`,
              height: "100%",
              backgroundColor: colors.foreground,
            }}
          />
        </View>
      )}
    </View>
  );
}

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
  members: BotSummary[];
  isGroup: boolean;
  /** The reply being written right now, which Stop stops. */
  activeRun: { id: string; botName: string } | null;
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
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedSend = useRef<{ key: string; clientId: string } | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // What you'd typed here before, unless you've started typing already.
  useEffect(() => {
    let current = true;
    void readDraft(chatId).then((draft) => {
      if (current && draft) setText((typed) => typed || draft);
    });
    return () => {
      current = false;
    };
  }, [chatId]);
  const edit = useCallback(
    (next: string) => {
      setText(next);
      writeDraft(chatId, next);
    },
    [chatId],
  );

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

  // Unmounting the chat drops what's uploading too.
  useEffect(
    () => () => {
      for (const pending of filesRef.current) pending.controller.abort();
    },
    [chatId],
  );

  const update = (key: string, change: Partial<Pending>) =>
    setFiles((current) =>
      current.map((pending) => (pending.key === key ? { ...pending, ...change } : pending)),
    );

  const upload = useCallback((pending: Pending) => {
    void uploadAttachment(pending.file, {
      signal: pending.controller.signal,
      onProgress: (progress) => update(pending.key, { progress }),
    }).then((answer) => {
      if (pending.controller.signal.aborted) return;
      if (answer.kind === "complete")
        update(pending.key, { state: "done", attachment: answer.attachment, progress: 1 });
      else
        update(pending.key, {
          state: "failed",
          error: answer.kind === "signedOut" ? "Sign in again to attach files." : answer.message,
        });
    });
  }, []);

  function add(picked: PickedFile[]) {
    setError(null);
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    if (picked.length > room) setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
    const added: Pending[] = picked.slice(0, Math.max(0, room)).map((file) => {
      const problem = cantAttach(file);
      return {
        key: Crypto.randomUUID(),
        file,
        progress: 0,
        state: problem ? "failed" : "uploading",
        error: problem ?? undefined,
        controller: new AbortController(),
      };
    });
    setFiles((current) => [...current, ...added]);
    for (const pending of added) if (pending.state === "uploading") upload(pending);
  }

  function retry(pending: Pending) {
    if (cantAttach(pending.file)) return;
    const next: Pending = {
      ...pending,
      state: "uploading",
      progress: 0,
      error: undefined,
      controller: new AbortController(),
    };
    setFiles((current) => current.map((entry) => (entry.key === pending.key ? next : entry)));
    upload(next);
  }

  function remove(pending: Pending) {
    pending.controller.abort();
    setFiles((current) => current.filter((entry) => entry.key !== pending.key));
  }

  async function pick(source: "camera" | "photos" | "files") {
    setAttachOpen(false);
    setError(null);
    if (source === "files") {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      add(
        result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          mime: asset.mimeType ?? "application/octet-stream",
          size: asset.size ?? 0,
        })),
      );
      return;
    }
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError("Allow open-bot to use the camera in Android's settings.");
        return;
      }
    }
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.85,
      allowsMultipleSelection: source === "photos",
      selectionLimit: MAX_ATTACHMENTS,
    };
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    add(
      result.assets.map((asset, index) => {
        const extension = asset.mimeType?.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
        return {
          uri: asset.uri,
          name:
            asset.fileName ??
            `${source === "camera" ? "photo" : "image"}-${Date.now()}${index ? `-${index}` : ""}.${extension}`,
          mime: asset.mimeType ?? "image/jpeg",
          size: asset.fileSize ?? 0,
        };
      }),
    );
  }

  const uploading = files.some((pending) => pending.state === "uploading");
  const failed = files.some((pending) => pending.state === "failed");
  const ready = files.filter((pending) => pending.state === "done");
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const canSend = hasContent && !uploading && !failed && !sending;

  async function send() {
    if (!canSend) return;
    if (dictation.listening) dictation.stop();
    const attachments = ready.map((pending) => pending.attachment!);
    const mentions = isGroup ? mentionedIds(text, members) : [];
    const key = JSON.stringify([chatId, text.trim(), attachments, mentions]);
    const clientId =
      failedSend.current?.key === key ? failedSend.current.clientId : Crypto.randomUUID();
    setSending(true);
    setError(null);
    const result = await safe(api.chats.send({ clientId, chatId, text, attachments, mentions }));
    setSending(false);
    if (result.error) {
      failedSend.current = { key, clientId };
      setError(errorMessage(result.error, "Couldn't send. Try again."));
      return;
    }
    failedSend.current = null;
    haptics.press();
    edit("");
    setCaret(0);
    const submitted = new Set(ready.map((pending) => pending.key));
    setFiles((current) => current.filter((pending) => !submitted.has(pending.key)));
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
        <View
          style={[styles.mentions, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="mention-menu"
        >
          {options.map((member) => (
            <Pressable
              key={member.id}
              onPress={() => {
                const next = insertMention(text, caret, member);
                edit(next.text);
                setCaret(next.caret);
                input.current?.setSelection(next.caret, next.caret);
              }}
              android_ripple={{ color: colors.muted }}
              style={styles.mention}
              accessibilityRole="button"
              testID="mention-option"
            >
              <BotAvatar name={member.name} color={member.color} emoji={member.emoji} size="sm" />
              <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
                {member.name}
              </Text>
              <Text variant="caption" muted numberOfLines={1} style={{ maxWidth: "45%" }}>
                {member.role}
              </Text>
            </Pressable>
          ))}
        </View>
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
              onRemove={() => remove(pending)}
              onRetry={() => retry(pending)}
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
            accessibilityLabel={`Stop ${activeRun?.botName ?? "your teammate"}`}
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
      <Sheet open={attachOpen} onClose={() => setAttachOpen(false)} testID="attach-sheet">
        <View style={styles.attachGrid}>
          {(
            [
              { source: "camera", label: "Camera", Icon: Camera, testID: "attach-camera" },
              { source: "photos", label: "Photos", Icon: ImageIcon, testID: "attach-photos" },
              { source: "files", label: "Files", Icon: FileUp, testID: "attach-files" },
            ] as const
          ).map(({ source, label, Icon, testID }) => (
            <Pressable
              key={source}
              onPress={() => {
                haptics.tap();
                void pick(source);
              }}
              accessibilityRole="button"
              accessibilityLabel={source === "camera" ? "Take a photo" : label}
              android_ripple={{ color: colors.muted }}
              style={[styles.attachTile, { backgroundColor: colors.subtle }]}
              testID={testID}
            >
              <View style={[styles.attachIcon, { backgroundColor: colors.surface }]}>
                <Icon size={22} color={colors.foreground} />
              </View>
              <Text variant="small" style={{ fontWeight: "500" }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
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
  attachGrid: {
    flexDirection: "row",
    gap: space(3),
    paddingHorizontal: space(5),
    paddingTop: space(1),
    paddingBottom: space(2),
  },
  attachTile: {
    flex: 1,
    alignItems: "center",
    gap: space(2),
    paddingVertical: space(4),
    borderRadius: radius.xl,
    overflow: "hidden",
  },
  attachIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingLeft: space(2.5),
    paddingRight: space(2),
    minHeight: 44,
    maxWidth: 240,
    overflow: "hidden",
  },
  progress: { position: "absolute", left: 0, right: 0, bottom: 0, height: 2 },
  mentions: {
    borderWidth: 1,
    borderRadius: radius.xl,
    overflow: "hidden",
    paddingVertical: space(1),
  },
  mention: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(3),
    minHeight: 44,
  },
});
