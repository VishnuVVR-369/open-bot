import type { TeammateSummary, ChatSummary } from "@open-bot/api";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import {
  activityText,
  TeammateAvatar,
  teammateActivity,
  LeadBadge,
  StatusLine,
} from "@/features/teammates/components/teammate-avatar";
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
  teammate,
  chat,
  first,
  computerOffline,
  onPress,
}: {
  teammate: TeammateSummary;
  chat: ChatSummary | undefined;
  first: boolean;
  computerOffline: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const activity = teammateActivity(teammate, computerOffline);
  const unread = Boolean(chat?.unread);
  const state = activityText(activity, teammate.activeRun?.waitingFor);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => {
        haptics.press();
        router.push(`/teammates/${teammate.id}`);
      }}
      accessibilityRole="button"
      accessibilityHint={`Hold to see ${teammate.name}'s profile`}
      accessibilityLabel={[
        teammate.name,
        teammate.isLead ? "lead" : null,
        state,
        teammate.role,
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
      <TeammateAvatar {...teammate} size="lg" activity={activity} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.nameRow}>
          <Text
            variant="label"
            numberOfLines={1}
            style={[{ flexShrink: 1, fontSize: 16 }, unread && { fontWeight: "700" }]}
          >
            {teammate.name}
          </Text>
          {teammate.isLead && <LeadBadge />}
          <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {teammate.role}
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
            <StatusLine activity={activity} waitingFor={teammate.activeRun?.waitingFor} />
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
  const open = (teammate: TeammateSummary) => {
    haptics.tap();
    const chatId =
      teammate.activeRun?.chatId ?? conversationWith(teammate, chats)?.id ?? teammate.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(teammate.id);
  };
  const sorted = rankTeammates(teammates, chats);
  return (
    <Section title="Teammates">
      <Card>
        {sorted.map((teammate, index) => (
          <TeammateRow
            key={teammate.id}
            teammate={teammate}
            chat={conversationWith(teammate, chats)}
            first={index === 0}
            computerOffline={computerOffline}
            onPress={() => open(teammate)}
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
