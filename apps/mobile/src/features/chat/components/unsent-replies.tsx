import notifee from "@notifee/react-native";
import type { MessageView, TeammateSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { AlertCircle, ChevronDown } from "lucide-react-native";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { recipients, sendMentions } from "@/features/chat/recipients";
import {
  discardUnsentReply,
  editUnsentReply,
  sendUnsentReply,
  useUnsentReplies,
  type UnsentReplyView,
} from "@/features/chat/unsent-replies";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { RecipientSheet } from "./recipient-sheet";

interface Chat {
  members: TeammateSummary[];
  isGroup: boolean;
  onSent: (message: MessageView) => void;
}

/**
 * Replies typed into a notification that couldn't be sent, above the composer, one card each:
 * send, edit or discard each on its own. They never join what you're typing. Several scroll within
 * part of the screen, so the composer stays in reach.
 */
export function UnsentReplies({ chatId, ...chat }: Chat & { chatId: string }) {
  const replies = useUnsentReplies(chatId);
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  if (replies.length === 0) return null;
  return (
    <ScrollView
      style={{ maxHeight: Math.max(160, (height - keyboard) * 0.4), flexGrow: 0 }}
      contentContainerStyle={styles.list}
      persistentScrollbar
      keyboardShouldPersistTaps="handled"
      testID="unsent-replies"
    >
      {replies.map((reply) => (
        <UnsentReplyCard key={reply.id} reply={reply} {...chat} />
      ))}
    </ScrollView>
  );
}

/** Whom a reply is for: its teammate, or a direct chat's; missing when they aren't in the chat. */
function recipientOf(reply: UnsentReplyView, { members, isGroup }: Chat) {
  const id = reply.teammateId ?? (isGroup ? null : (members[0]?.id ?? null));
  const member = id ? recipients([id], members)[0]!.member : undefined;
  const label = member
    ? `to ${member.name}`
    : id
      ? "to a teammate who isn't in this chat"
      : "not addressed to anyone yet";
  return { id, member, label };
}

function UnsentReplyCard({ reply, ...chat }: Chat & { reply: UnsentReplyView }) {
  const colors = useColors();
  const { members, isGroup, onSent } = chat;
  // What's being changed in the card, applied with Save.
  const [editing, setEditing] = useState<{ text: string; teammateId: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const shown = editing ? { ...reply, ...editing } : reply;
  const to = recipientOf(shown, chat);
  const busy = reply.sending;

  const send = async () => {
    haptics.press();
    const sent = await sendUnsentReply(reply.id, async (unsent) => {
      const result = await safe(
        api.chats.send({
          clientId: unsent.clientId,
          chatId: unsent.chatId,
          text: unsent.text,
          attachments: [],
          mentions: sendMentions(
            unsent.text,
            unsent.teammateId ? [unsent.teammateId] : [],
            members,
            isGroup,
          ),
        }),
      );
      if (result.error) return { error: errorMessage(result.error, "Couldn't send. Try again.") };
      onSent(result.data);
      return null;
    });
    if (sent) void notifee.cancelNotification(reply.id).catch(() => {});
    else haptics.error();
  };
  const discard = async () => {
    haptics.warning();
    if (await discardUnsentReply(reply.id))
      void notifee.cancelNotification(reply.id).catch(() => {});
  };
  const save = async () => {
    if (editing && (await editUnsentReply(reply.id, editing))) setEditing(null);
  };

  return (
    <View
      style={[
        styles.card,
        {
          borderColor: mix(colors.attention, colors.surface, 0.55),
          backgroundColor: mix(colors.attention, colors.surface, 0.08),
        },
      ]}
      testID="unsent-reply"
    >
      <View style={styles.head}>
        <AlertCircle size={15} color={colors.attentionInk} />
        <Text
          variant="small"
          numberOfLines={1}
          style={{ flexShrink: 1, color: colors.attentionInk, fontWeight: "600" }}
          testID="unsent-reply-label"
        >
          {`Not sent - ${to.label}`}
        </Text>
      </View>
      {editing ? (
        <>
          <TextInput
            value={editing.text}
            onChangeText={(text) => setEditing({ ...editing, text })}
            multiline
            autoFocus
            style={[
              styles.input,
              {
                color: colors.foreground,
                borderColor: colors.input,
                backgroundColor: colors.surface,
              },
            ]}
            cursorColor={colors.foreground}
            selectionColor={colors.input}
            accessibilityLabel="Reply"
            testID="unsent-reply-input"
          />
          {isGroup && (
            <Pressable
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              accessibilityLabel={`${to.member ? `To ${to.member.name}` : "Pick who it's for"}. Change`}
              style={[styles.to, { borderColor: colors.input, backgroundColor: colors.surface }]}
              testID="unsent-reply-to"
            >
              {to.member && (
                <TeammateAvatar
                  name={to.member.name}
                  color={to.member.color}
                  emoji={to.member.emoji}
                  size="xs"
                />
              )}
              <Text variant="small" numberOfLines={1} style={{ flexShrink: 1 }}>
                {to.member ? `To ${to.member.name}` : "Pick who it's for"}
              </Text>
              <ChevronDown size={15} color={colors.mutedForeground} />
            </Pressable>
          )}
        </>
      ) : (
        <Text
          variant="small"
          numberOfLines={4}
          selectable
          style={{ fontSize: 14, lineHeight: 20 }}
          testID="unsent-reply-text"
        >
          {reply.text}
        </Text>
      )}
      {!to.member && !editing && (
        <Pressable
          onPress={() => setPicking(true)}
          disabled={busy}
          accessibilityRole="button"
          hitSlop={6}
          testID="unsent-reply-pick"
        >
          <Text variant="small" style={{ fontWeight: "600", textDecorationLine: "underline" }}>
            Pick who it's for to send it
          </Text>
        </Pressable>
      )}
      {reply.error && !editing && (
        <Text variant="small" style={{ color: colors.destructive }} accessibilityRole="alert">
          {reply.error}
        </Text>
      )}
      <View style={styles.actions}>
        {editing ? (
          <>
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setEditing(null)}
              style={styles.action}
              testID="unsent-reply-cancel"
            />
            <View style={{ flex: 1 }} />
            <Button
              title="Save"
              onPress={() => void save()}
              disabled={busy || !editing.text.trim()}
              style={styles.action}
              testID="unsent-reply-save"
            />
          </>
        ) : (
          <>
            <Button
              title="Discard"
              variant="ghost"
              onPress={() => void discard()}
              disabled={busy}
              style={styles.action}
              testID="unsent-reply-discard"
            />
            <View style={{ flex: 1 }} />
            <Button
              title="Edit"
              variant="outline"
              onPress={() => setEditing({ text: reply.text, teammateId: reply.teammateId })}
              disabled={busy}
              style={styles.action}
              testID="unsent-reply-edit"
            />
            <Button
              title="Send"
              onPress={() => void send()}
              busy={busy}
              disabled={!to.member}
              style={styles.action}
              testID="unsent-reply-send"
            />
          </>
        )}
      </View>
      <RecipientSheet
        open={picking}
        options={members.filter((member) => member.id !== to.id)}
        onClose={() => setPicking(false)}
        onPick={(member) => {
          setPicking(false);
          if (editing) setEditing({ ...editing, teammateId: member.id });
          else void editUnsentReply(reply.id, { teammateId: member.id });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(2) },
  card: { borderWidth: 1, borderRadius: radius.xl + 2, padding: space(3.5), gap: space(2.5) },
  head: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  input: {
    borderWidth: 1,
    borderRadius: radius.lg,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    maxHeight: 120,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    textAlignVertical: "top",
  },
  to: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1.5),
  },
  actions: { flexDirection: "row", alignItems: "center", gap: space(2) },
  action: { minHeight: 36, paddingHorizontal: space(3.5) },
});
