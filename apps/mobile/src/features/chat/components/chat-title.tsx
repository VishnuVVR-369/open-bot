import type { BotSummary, ChatSummary } from "@open-bot/api";
import type { TeammateActivity } from "@open-bot/domain";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { AvatarStack, BotAvatar, StatusLine } from "@/features/teammates/components/bot-avatar";
import { Text } from "@/components/text";
import { namedForTopic } from "@/features/chat/chats";
import { space, useColors } from "@/theme";

/**
 * The chat's header: who it's with and what is happening in it. On a chat with one teammate it
 * opens their profile.
 */
export function ChatTitle({
  chat,
  teammate,
  members,
  title,
  activity,
  text,
}: {
  chat: ChatSummary;
  /** The teammate of a chat that isn't a group, as the roster has them now. */
  teammate: BotSummary | undefined;
  members: BotSummary[];
  title: string;
  activity: TeammateActivity;
  /** The status words, or null for an idle group. */
  text: string | null;
}) {
  const colors = useColors();
  const isGroup = chat.kind === "group";
  return (
    <Pressable
      style={styles.headerTitle}
      disabled={!teammate}
      onPress={() => teammate && router.push(`/teammates/${teammate.id}`)}
      accessibilityRole={teammate ? "button" : undefined}
      accessibilityHint={teammate ? `Opens ${teammate.name}'s profile` : undefined}
      testID="chat-header"
    >
      {isGroup ? (
        <AvatarStack members={members} ring={colors.background} />
      ) : (
        teammate && (
          <BotAvatar
            name={teammate.name}
            color={teammate.color}
            emoji={teammate.emoji}
            size="md"
            activity={activity}
          />
        )
      )}
      <View style={{ flexShrink: 1 }}>
        <Text variant="heading" numberOfLines={1} style={{ fontSize: 16, lineHeight: 20 }}>
          {title}
        </Text>
        {isGroup && activity === "idle" ? (
          // Nothing happening here: who's in it, without a status light.
          <Text variant="caption" muted numberOfLines={1} testID="chat-status">
            {members.length} teammates
          </Text>
        ) : isGroup ? (
          <StatusLine activity={activity} size="caption" testID="chat-status">
            {[`${members.length} teammates`, text].filter(Boolean).join(" · ")}
          </StatusLine>
        ) : (
          <StatusLine activity={activity} size="caption" testID="chat-status">
            {`${namedForTopic(chat, teammate) ? `${teammate!.name} · ` : ""}${text}`}
          </StatusLine>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    maxWidth: 260,
    minHeight: 48,
  },
});
