import type { TeammateSummary, ChatSummary } from "@open-bot/api";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import {
  activityText,
  BotAvatar,
  botActivity,
  LeadBadge,
  StatusLine,
} from "@/features/teammates/components/bot-avatar";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { conversationWith } from "@/features/chat/chats";
import { haptics } from "@/lib/haptics";
import { useNewDirectChat } from "@/features/chat/hooks";
import { ago } from "@/lib/time";
import { useColors, space } from "@/theme";
import { rankTeammates } from "@/features/home/home";

/**
 * One teammate: their face, name and job, and their status from the fixed list (the same words as
 * the web and the Computer tab). When you last talked is on the right.
 */
function TeammateRow({
  bot,
  chat,
  first,
  computerOffline,
  onPress,
}: {
  bot: TeammateSummary;
  chat: ChatSummary | undefined;
  first: boolean;
  computerOffline: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const activity = botActivity(bot, computerOffline);
  const unread = Boolean(chat?.unread);
  const state = activityText(activity, bot.activeRun?.waitingFor);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => {
        haptics.press();
        router.push(`/teammates/${bot.id}`);
      }}
      accessibilityRole="button"
      accessibilityHint={`Hold to see ${bot.name}'s profile`}
      accessibilityLabel={[
        bot.name,
        bot.isLead ? "lead" : null,
        state,
        bot.role,
        unread ? "unread" : null,
      ]
        .filter(Boolean)
        .join(", ")}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.teammate,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID="teammate"
    >
      <BotAvatar {...bot} size="lg" activity={activity} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.nameRow}>
          <Text
            variant="label"
            numberOfLines={1}
            style={[{ flexShrink: 1, fontSize: 16 }, unread && { fontWeight: "700" }]}
          >
            {bot.name}
          </Text>
          {bot.isLead && <LeadBadge />}
          <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {bot.role}
          </Text>
          {chat && (
            <Text
              variant="caption"
              muted={!unread}
              style={[{ marginLeft: "auto" }, unread && { fontWeight: "600" }]}
            >
              {ago(chat.lastActivityAt)}
            </Text>
          )}
        </View>
        <View style={styles.previewRow}>
          <View style={{ flex: 1 }}>
            <StatusLine activity={activity} waitingFor={bot.activeRun?.waitingFor} />
          </View>
          {unread && <View style={[styles.unread, { backgroundColor: colors.foreground }]} />}
        </View>
      </View>
    </Pressable>
  );
}

export function Teammates({
  teammates,
  chats,
  computerOffline,
}: {
  teammates: TeammateSummary[];
  chats: ChatSummary[];
  computerOffline: boolean;
}) {
  const newChat = useNewDirectChat();
  const open = (bot: TeammateSummary) => {
    haptics.tap();
    const chatId = bot.activeRun?.chatId ?? conversationWith(bot, chats)?.id ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };
  const sorted = rankTeammates(teammates, chats);
  return (
    <Section title="Teammates">
      <Card>
        {sorted.map((bot, index) => (
          <TeammateRow
            key={bot.id}
            bot={bot}
            chat={conversationWith(bot, chats)}
            first={index === 0}
            computerOffline={computerOffline}
            onPress={() => open(bot)}
          />
        ))}
      </Card>
    </Section>
  );
}

const styles = StyleSheet.create({
  teammate: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 72,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  previewRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  unread: { width: 9, height: 9, borderRadius: 5 },
});
