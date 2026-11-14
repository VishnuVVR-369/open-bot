import type { ChatSummary, PageDetail } from "@open-bot/api";
import { pageQuestionText } from "@open-bot/domain";
import { safe } from "@orpc/client";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Send } from "lucide-react-native";
import { useRef, useState } from "react";
import { Alert, StyleSheet, View, type TextInputInstance } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { queryClient, queryKeys } from "@/lib/query";
import { space, useColors } from "@/theme";

/** Where a question about a page points: a quote from it and its section, or the whole page. */
export interface Question {
  quote: string | null;
  section: string | null;
}

/** Asks the page's teammate about it, in the chat it came from, with the version and the quote. */
export function AskSheet({
  open,
  onClose,
  page,
  version,
  teammate,
  chat,
  question,
}: {
  open: boolean;
  onClose: () => void;
  page: PageDetail;
  version: number;
  teammate: { id: string; name: string };
  chat: ChatSummary;
  question: Question;
}) {
  const colors = useColors();
  const input = useRef<TextInputInstance>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // The same id for every try of one question, so a retry after a lost answer isn't sent twice.
  const clientId = useRef(Crypto.randomUUID());

  const send = async () => {
    const draft = text.trim();
    if (!draft || sending) return;
    setSending(true);
    const result = await safe(
      api.chats.send({
        clientId: clientId.current,
        chatId: chat.id,
        text: pageQuestionText({
          pageId: page.id,
          title: page.title,
          version,
          quote: question.quote,
          section: question.section,
          text: draft,
        }),
        attachments: [],
        mentions: chat.kind === "group" ? [teammate.id] : [],
      }),
    );
    setSending(false);
    if (result.error) {
      Alert.alert("Couldn't send", errorMessage(result.error));
      return;
    }
    haptics.success();
    clientId.current = Crypto.randomUUID();
    setText("");
    onClose();
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
    Alert.alert(
      `Sent to ${teammate.name}`,
      "Their answer shows in the chat. If they change the page, the new version shows here.",
      [
        { text: "Stay here", style: "cancel" },
        { text: "Open chat", onPress: () => router.push(chatHref(chat.id)) },
      ],
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Ask ${teammate.name}`}
      description={
        chat.kind === "group" ? `Goes to ${chat.title}` : `Goes to your chat with ${teammate.name}`
      }
      focusOnShow={input}
      testID="page-ask"
    >
      <View style={styles.askBody}>
        {question.quote && (
          <View style={[styles.quote, { borderColor: colors.input }]}>
            {question.section && (
              <Text variant="overline" muted numberOfLines={1}>
                {question.section}
              </Text>
            )}
            <Text variant="small" muted numberOfLines={4}>
              {question.quote}
            </Text>
          </View>
        )}
        <TextField
          ref={input}
          value={text}
          onChangeText={setText}
          multiline
          placeholder={
            question.quote
              ? "What would you like to know about this?"
              : "Ask a question or ask for a change"
          }
          accessibilityLabel="Your question"
          testID="page-ask-input"
        />
        <Button
          title="Send"
          icon={<Send size={16} color={colors.primaryForeground} />}
          onPress={() => void send()}
          disabled={!text.trim()}
          busy={sending}
          testID="page-ask-send"
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  askBody: { paddingHorizontal: space(5), gap: space(3), paddingTop: space(1) },
  quote: { borderLeftWidth: 2, paddingLeft: space(3), gap: 2 },
});
