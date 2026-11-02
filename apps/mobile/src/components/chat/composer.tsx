import type { MessageView } from "@open-bot/api";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { ArrowUp } from "lucide-react-native";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { fonts, radius, space, useColors } from "@/theme";

/**
 * Where you write to a teammate. Each message gets an id when you first send it, and a retry of
 * the same message reuses it, so a send that timed out but arrived isn't delivered twice.
 */
export function Composer({
  chatId,
  placeholder,
  onSent,
}: {
  chatId: string;
  placeholder: string;
  onSent: (message: MessageView) => void;
}) {
  const colors = useColors();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failedSend = useRef<{ key: string; clientId: string } | null>(null);
  const canSend = text.trim().length > 0 && !sending;

  async function send() {
    if (!canSend) return;
    const key = JSON.stringify([chatId, text.trim()]);
    const clientId =
      failedSend.current?.key === key ? failedSend.current.clientId : Crypto.randomUUID();
    setSending(true);
    setError(null);
    const result = await safe(
      api.chats.send({ clientId, chatId, text, attachments: [], mentions: [] }),
    );
    setSending(false);
    if (result.error) {
      failedSend.current = { key, clientId };
      setError(errorMessage(result.error, "Couldn't send. Try again."));
      return;
    }
    failedSend.current = null;
    setText("");
    onSent(result.data);
  }

  return (
    <View style={{ gap: space(1.5) }}>
      {error && (
        <Text variant="small" style={{ color: colors.destructive, paddingHorizontal: space(1) }}>
          {error}
        </Text>
      )}
      <View style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.input }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
          style={[styles.input, { color: colors.foreground }]}
          cursorColor={colors.foreground}
          selectionColor={colors.input}
          textAlignVertical="center"
          testID="composer-input"
        />
        <Pressable
          onPress={() => void send()}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderRadius: radius.xl + 6,
    paddingLeft: space(4),
    paddingRight: space(1.5),
    paddingVertical: space(1.5),
    gap: space(2),
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 140,
    minHeight: 36,
    paddingTop: 7,
    paddingBottom: 7,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
