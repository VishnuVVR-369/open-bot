import type { ChatEntry } from "@open-bot/api";
import { isRunActive } from "@open-bot/shared";
import { Stack, useLocalSearchParams } from "expo-router";
import { Plus, Users } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar, botActivity } from "@/components/bot-avatar";
import { Composer } from "@/components/chat/composer";
import { RunBlock } from "@/components/chat/run-block";
import { UserMessage } from "@/components/chat/user-message";
import { ConnectionNotice } from "@/components/connection-notice";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { useNewDirectChat, useTeammates } from "@/lib/queries";
import { useChat } from "@/lib/use-chat";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";

/** A conversation with a teammate (or a group), live while you're looking at it. */
export default function ChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { chatId, run: runParam } = useLocalSearchParams<{ chatId: string; run?: string }>();
  const { chat, members, entries, runs, loading, error, refetch, addSent } = useChat(chatId);
  const { data: teammates } = useTeammates();
  const newChat = useNewDirectChat();
  const allBots = teammates ?? members;
  const list = useRef<FlatList<ChatEntry>>(null);

  const isGroup = chat?.kind === "group";
  const bot = !isGroup ? members[0] : undefined;
  const liveBot = bot && (allBots.find((candidate) => candidate.id === bot.id) ?? bot);
  const title = !chat
    ? ""
    : chat.kind === "scheduled"
      ? `${bot?.name ?? ""} · Scheduled`
      : chat.kind === "inbox"
        ? `${bot?.name ?? ""} · Email`
        : chat.title;

  // Messages that joined a running turn show inside that turn, not on their own.
  const steered = useMemo(() => {
    const ids = new Set<string>();
    for (const run of Object.values(runs))
      for (const item of run.timeline.items)
        if (item.kind === "user_message") ids.add(item.messageId);
    return ids;
  }, [runs]);

  // Newest first: the list is inverted, so it starts at the bottom and stays there as replies stream.
  const data = useMemo(
    () =>
      entries
        .filter(
          (entry) =>
            entry.type !== "message" ||
            (!entry.message.steeredRunId && !steered.has(entry.message.id)),
        )
        .reverse(),
    [entries, steered],
  );

  const activeRun = useMemo(
    () =>
      Object.values(runs)
        .filter((run) => isRunActive(run.timeline.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [runs],
  );
  const activeName =
    activeRun && allBots.find((candidate) => candidate.id === activeRun.botId)?.name;
  const placeholder = activeRun
    ? `Add to what ${activeName ?? "your teammate"} is doing…`
    : isGroup
      ? "Message the group…"
      : `Message ${bot?.name ?? "your teammate"}…`;

  // Opened at one run, like from a notification: scroll to it once.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!runParam || jumped.current === runParam || data.length === 0) return;
    const index = data.findIndex((entry) => entry.type === "run" && entry.run.id === runParam);
    if (index <= 0) return;
    jumped.current = runParam;
    requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index, viewPosition: 1, animated: false }),
    );
  }, [runParam, data]);

  const renderItem = useCallback(
    ({ item: entry }: { item: ChatEntry }) =>
      entry.type === "message" ? (
        <UserMessage message={entry.message} />
      ) : (
        <RunBlock
          run={runs[entry.run.id] ?? entry.run}
          chatId={chatId}
          bot={allBots.find((candidate) => candidate.id === entry.run.botId)}
          bots={allBots}
        />
      ),
    [runs, chatId, allBots],
  );

  return (
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <Stack.Screen
        options={{
          headerTitle: () =>
            chat ? (
              <View style={styles.headerTitle}>
                {isGroup ? (
                  <View style={[styles.groupMark, { backgroundColor: colors.subtle }]}>
                    <Users size={16} color={colors.mutedForeground} />
                  </View>
                ) : (
                  liveBot && (
                    <BotAvatar
                      name={liveBot.name}
                      color={liveBot.color}
                      emoji={liveBot.emoji}
                      size="sm"
                      activity={botActivity(liveBot)}
                    />
                  )
                )}
                <View style={{ flexShrink: 1 }}>
                  <Text
                    variant="heading"
                    numberOfLines={1}
                    style={{ fontSize: 16, lineHeight: 20 }}
                  >
                    {title}
                  </Text>
                  <Text variant="caption" muted numberOfLines={1}>
                    {isGroup ? members.map((member) => member.name).join(", ") : bot?.role}
                  </Text>
                </View>
              </View>
            ) : null,
          headerRight: () =>
            chat?.kind === "direct" && bot ? (
              <Pressable
                onPress={() => newChat.mutate(bot.id)}
                disabled={newChat.isPending}
                accessibilityRole="button"
                accessibilityLabel={`New chat with ${bot.name}`}
                hitSlop={8}
              >
                <Plus size={22} color={colors.foreground} />
              </Pressable>
            ) : null,
        }}
      />
      {loading ? (
        <Loading />
      ) : error || !chat ? (
        <LoadError error={error} onRetry={() => void refetch()} />
      ) : (
        <FlatList
          ref={list}
          data={data}
          inverted
          keyExtractor={(entry) => (entry.type === "message" ? entry.message.id : entry.run.id)}
          renderItem={renderItem}
          ItemSeparatorComponent={Gap}
          ListFooterComponent={<View style={{ height: space(2) }} />}
          contentContainerStyle={[styles.timeline, data.length === 0 && { flex: 1 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={({ index }) =>
            setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 1 }), 200)
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Empty
                icon={
                  bot ? (
                    <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="lg" />
                  ) : (
                    <Users size={28} color={colors.mutedForeground} />
                  )
                }
                title={
                  isGroup ? "Start the conversation" : `Give ${bot?.name ?? "them"} something to do`
                }
                body={
                  isGroup
                    ? "Your message goes to the lead teammate. They pass work to each other."
                    : `${bot?.name ?? "Your teammate"} works on the shared computer while you're away.`
                }
              />
            </View>
          }
        />
      )}
      {chat && (
        <View
          style={[
            styles.composer,
            {
              paddingBottom: keyboard > 0 ? space(2) : Math.max(insets.bottom, space(2)) + space(1),
            },
          ]}
        >
          <ConnectionNotice />
          <Composer
            chatId={chat.id}
            placeholder={placeholder}
            onSent={(message) => {
              addSent(message);
              list.current?.scrollToOffset({ offset: 0, animated: true });
            }}
          />
        </View>
      )}
    </View>
  );
}

function Gap() {
  return <View style={{ height: space(6) }} />;
}

const styles = StyleSheet.create({
  headerTitle: { flexDirection: "row", alignItems: "center", gap: space(2.5), maxWidth: 260 },
  groupMark: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  timeline: { paddingHorizontal: space(4), paddingVertical: space(4) },
  // No transform: the inverted list already flips its empty state back (both axes on Android),
  // and a transform here would replace that flip and leave the text mirrored.
  empty: { flex: 1 },
  composer: { paddingHorizontal: space(3), paddingTop: space(2) },
});
