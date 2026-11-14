import type { TeammateSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Check, Link2, Share2 } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { Button } from "@/components/button";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import { useTeammates } from "@/features/teammates/hooks";
import { parseShared, SHARE_PRESETS, shareMessage, type SharePreset } from "@/features/chat/share";
import { useLatestShare } from "@/features/chat/share-inbox";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { radius, space, useColors } from "@/theme";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Choice({
  selected,
  onPress,
  leading,
  title,
  subtitle,
  first,
  testID,
}: {
  selected: boolean;
  onPress: () => void;
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  first: boolean;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      android_ripple={{ color: colors.muted }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={[
        styles.choice,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
      ]}
      testID={testID}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" muted numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        style={[
          styles.radio,
          selected
            ? { backgroundColor: colors.primary, borderColor: colors.primary }
            : { borderColor: colors.input },
        ]}
      >
        {selected && <Check size={13} color={colors.primaryForeground} strokeWidth={3} />}
      </View>
    </Pressable>
  );
}

/** Something shared from another app, on its way to a teammate: who gets it, and what to do with it. */
export default function ShareScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const queryClient = useQueryClient();
  const shared = useLatestShare();
  const item = useMemo(() => (shared ? parseShared(shared) : null), [shared]);
  const { data: bots, error, isLoading, refetch } = useTeammates();
  const [preset, setPreset] = useState<SharePreset>("page");
  const [botId, setBotId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clientId = useRef(Crypto.randomUUID());
  // A new share (shared again while this is open) is a new message.
  const shareId = shared?.id;
  useEffect(() => {
    clientId.current = Crypto.randomUUID();
    setProblem(null);
  }, [shareId]);

  if (!item)
    return (
      <Empty
        icon={<Share2 size={28} color={colors.mutedForeground} />}
        title="Nothing to share"
        body="Share a link or some text from another app, and pick open-bot."
        action={<Button title="Go home" variant="outline" onPress={() => router.replace("/")} />}
      />
    );
  if (isLoading) return <Loading />;
  if (error && !bots) return <LoadError error={error} onRetry={() => void refetch()} />;
  const teammates = bots ?? [];
  if (teammates.length === 0)
    return (
      <Empty
        icon={<Share2 size={28} color={colors.mutedForeground} />}
        title="No teammates yet"
        body="Create a teammate in open-bot on a computer, then share again."
      />
    );
  const chosen: TeammateSummary =
    teammates.find((bot) => bot.id === botId) ??
    teammates.find((bot) => bot.isLead) ??
    teammates[0]!;

  const send = async () => {
    if (sending) return;
    setSending(true);
    setProblem(null);
    let chatId = chosen.directChatId;
    if (!chatId) {
      const created = await safe(api.chats.newDirect({ teammateId: chosen.id }));
      if (created.error) {
        setSending(false);
        setProblem(errorMessage(created.error));
        return;
      }
      chatId = created.data.chatId;
    }
    const result = await safe(
      api.chats.send({
        clientId: clientId.current,
        chatId,
        text: shareMessage(preset, item, note),
        attachments: [],
        mentions: [],
      }),
    );
    setSending(false);
    if (result.error) {
      setProblem(errorMessage(result.error));
      return;
    }
    haptics.success();
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    router.replace(`/chats/${chatId}`);
  };

  return (
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="share"
      >
        <View
          style={[styles.preview, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          {item.url && (
            <View style={styles.link}>
              <View style={[styles.linkMark, { backgroundColor: colors.subtle }]}>
                <Link2 size={16} color={colors.mutedForeground} />
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="label" numberOfLines={1}>
                  {host(item.url)}
                </Text>
                <Text variant="caption" muted numberOfLines={1}>
                  {item.url}
                </Text>
              </View>
            </View>
          )}
          {item.text ? (
            <Text variant="small" muted={Boolean(item.url)} numberOfLines={item.url ? 3 : 6}>
              {item.text}
            </Text>
          ) : null}
        </View>

        <Section title="What should they do?">
          <Card>
            {SHARE_PRESETS.map((entry, index) => (
              <Choice
                key={entry.id}
                first={index === 0}
                selected={preset === entry.id}
                onPress={() => setPreset(entry.id)}
                title={entry.label}
                subtitle={entry.hint}
                testID={`share-preset-${entry.id}`}
              />
            ))}
          </Card>
        </Section>

        <Section title="Who">
          <Card>
            {teammates.map((bot, index) => (
              <Choice
                key={bot.id}
                first={index === 0}
                selected={bot.id === chosen.id}
                onPress={() => setBotId(bot.id)}
                leading={<BotAvatar {...bot} size="sm" />}
                title={bot.name}
                subtitle={bot.role}
                testID="share-teammate"
              />
            ))}
          </Card>
        </Section>

        <TextField
          value={note}
          onChangeText={setNote}
          multiline
          placeholder={
            preset === "page" ? "Anything to focus on? (optional)" : "Add a note (optional)"
          }
          accessibilityLabel="Your note"
          style={{ minHeight: 76 }}
          testID="share-note"
        />
        {problem && (
          <Text variant="small" style={{ color: colors.destructive }}>
            {problem}
          </Text>
        )}
      </ScrollView>
      <View
        style={[
          styles.footer,
          {
            borderColor: colors.border,
            backgroundColor: colors.background,
            paddingBottom: keyboard > 0 ? space(3) : insets.bottom + space(3),
          },
        ]}
      >
        <Button
          title={`Send to ${chosen.name}`}
          onPress={() => void send()}
          busy={sending}
          testID="share-send"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(2), gap: space(6), paddingBottom: space(6) },
  preview: { borderWidth: 1, borderRadius: radius.xl, padding: space(3.5), gap: space(2.5) },
  link: { flexDirection: "row", alignItems: "center", gap: space(3) },
  linkMark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 60,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space(4),
    paddingTop: space(3),
  },
});
