import type { ChatEntry, ChatSummary } from "@open-bot/api";
import { isRunActive } from "@open-bot/shared";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Archive, EllipsisVertical, Pencil, SquarePen, Users } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar, botActivity } from "@/components/bot-avatar";
import { Composer } from "@/components/chat/composer";
import { RunBlock } from "@/components/chat/run-block";
import { UserMessage } from "@/components/chat/user-message";
import { Button } from "@/components/button";
import { ConnectionNotice } from "@/components/connection-notice";
import { Sheet, SheetItem } from "@/components/sheet";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage, isGone } from "@/lib/errors";
import { queryKeys } from "@/lib/query";
import { useNewDirectChat, useTeammates } from "@/lib/queries";
import { useChat } from "@/lib/use-chat";
import { useChatRunTarget } from "@/lib/use-chat-run-target";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space, useColors } from "@/theme";

/** A conversation with a teammate (or a group), live while you're looking at it. */
export default function ChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { chatId, run: runParam } = useLocalSearchParams<{ chatId: string; run?: string }>();
  const {
    chat,
    members,
    entries,
    runs,
    loading,
    error,
    refetch,
    addSent,
    hasMore,
    loadingOlder,
    olderError,
    loadOlder,
  } = useChat(chatId);
  const [menuOpen, setMenuOpen] = useState(false);
  // Archived (here or on another device) or deleted: what's cached of it is no use anymore.
  const gone = isGone(error);
  const { data: teammates } = useTeammates();
  const newChat = useNewDirectChat();
  const allBots = teammates ?? members;
  const list = useRef<FlatList<ChatEntry>>(null);
  const scrollRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAttempts = useRef(0);
  useEffect(
    () => () => {
      if (scrollRetry.current) clearTimeout(scrollRetry.current);
    },
    [chatId, runParam],
  );

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
      ? "Message the group, @ to pick who…"
      : `Message ${bot?.name ?? "your teammate"}…`;

  // A run is superseded once the same teammate has run again after it, so it has no Try again.
  const superseded = useMemo(() => {
    const result = new Set<string>();
    const seen = new Set<string>();
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "run") continue;
      if (seen.has(entry.run.botId)) result.add(entry.run.id);
      seen.add(entry.run.botId);
    }
    return result;
  }, [entries]);

  const scrollToRun = useCallback((index: number) => {
    scrollAttempts.current = 0;
    requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index, viewPosition: 1, animated: false }),
    );
  }, []);
  useChatRunTarget({
    chatId,
    runId: runParam,
    items: data,
    oldest: entries[0]?.at,
    hasMore,
    loading: loading || loadingOlder || Boolean(error),
    loadOlder,
    scrollToIndex: scrollToRun,
  });

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
          superseded={superseded.has(entry.run.id)}
        />
      ),
    [runs, chatId, allBots, superseded],
  );

  return (
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <Stack.Screen
        options={{
          // A plain title when there's nothing to show: a title view of nothing hides the back arrow.
          headerTitle:
            !chat || gone
              ? ""
              : () => (
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
                ),
          headerRight: () =>
            chat && !gone && (chat.kind === "direct" || chat.kind === "group") ? (
              <Pressable
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Chat options"
                hitSlop={10}
                testID="chat-menu"
              >
                <EllipsisVertical size={22} color={colors.foreground} />
              </Pressable>
            ) : null,
        }}
      />
      {Boolean(olderError) && (
        <View style={{ padding: space(3), gap: space(2) }}>
          <Text variant="small" style={{ color: colors.destructive }}>
            Couldn't load earlier messages.
          </Text>
          <Button title="Retry" variant="outline" onPress={() => void loadOlder()} />
        </View>
      )}
      {loading ? (
        <Loading />
      ) : gone ? (
        <Empty
          icon={<Archive size={28} color={colors.mutedForeground} />}
          title="This chat isn't available"
          body="It may have been archived."
          action={<Button title="Go back" variant="outline" onPress={goBack} />}
        />
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
          ListFooterComponent={
            <View style={styles.older}>
              {loadingOlder && <ActivityIndicator size="small" color={colors.mutedForeground} />}
            </View>
          }
          onEndReached={() => {
            if (hasMore) void loadOlder();
          }}
          onEndReachedThreshold={0.4}
          contentContainerStyle={[styles.timeline, data.length === 0 && { flex: 1 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            // Move the render window toward an unmeasured row before trying its exact index.
            list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            if (scrollRetry.current) clearTimeout(scrollRetry.current);
            if (scrollAttempts.current++ >= 8) return;
            scrollRetry.current = setTimeout(() => {
              scrollRetry.current = null;
              list.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
            }, 200);
          }}
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
      {chat && !gone && (
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
            members={members}
            isGroup={isGroup}
            activeRun={
              activeRun ? { id: activeRun.id, botName: activeName ?? "your teammate" } : null
            }
            onSent={(message) => {
              addSent(message);
              list.current?.scrollToOffset({ offset: 0, animated: true });
            }}
          />
        </View>
      )}
      {chat && !gone && (
        <ChatMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          chat={chat}
          onNewChat={() => {
            setMenuOpen(false);
            if (chat.kind === "direct" && bot) newChat.mutate(bot.id);
            else router.push("/new-chat");
          }}
        />
      )}
    </View>
  );
}

/**
 * What you can do with a chat: start another, rename it, or archive it. Renaming happens in the
 * same sheet, so its field gets the keyboard (a second sheet opening as this one closes doesn't).
 */
function ChatMenu({
  open,
  onClose,
  chat,
  onNewChat,
}: {
  open: boolean;
  onClose: () => void;
  chat: ChatSummary;
  onNewChat: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (open) setRenaming(false);
  }, [open]);
  const archive = () => {
    onClose();
    Alert.alert(
      "Archive this chat?",
      "It's hidden from your chats. Its history stays, and teammates keep what they learned.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: async () => {
            const result = await safe(api.chats.archive({ chatId: chat.id }));
            if (result.error) {
              Alert.alert("Couldn't archive it", errorMessage(result.error));
              return;
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
            router.back();
          },
        },
      ],
    );
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={renaming ? "Rename chat" : undefined}
      testID="chat-menu-sheet"
    >
      {renaming ? (
        <RenameForm chat={chat} onDone={onClose} />
      ) : (
        <>
          <SheetItem
            icon={<SquarePen size={20} color={colors.foreground} />}
            label={chat.kind === "direct" ? "New chat" : "New group"}
            onPress={onNewChat}
            testID="menu-new-chat"
          />
          <SheetItem
            icon={<Pencil size={20} color={colors.foreground} />}
            label="Rename"
            onPress={() => setRenaming(true)}
            testID="menu-rename"
          />
          <SheetItem
            icon={<Archive size={20} color={colors.destructive} />}
            label="Archive"
            destructive
            onPress={archive}
            testID="menu-archive"
          />
        </>
      )}
    </Sheet>
  );
}

function RenameForm({ chat, onDone }: { chat: ChatSummary; onDone: () => void }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setProblem(null);
    const result = await safe(api.chats.rename({ chatId: chat.id, title: title.trim() }));
    setSaving(false);
    if (result.error) {
      setProblem(errorMessage(result.error));
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chat.id) });
    onDone();
  }

  return (
    <View style={styles.sheetForm}>
      <TextField
        value={title}
        onChangeText={setTitle}
        maxLength={60}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        testID="rename-title"
      />
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {problem}
        </Text>
      )}
      <Button
        title="Save"
        onPress={() => void save()}
        disabled={!title.trim() || title.trim() === chat.title}
        busy={saving}
        testID="rename-save"
      />
    </View>
  );
}

/** Back where you came from, or to the chats when the chat was opened straight from a link. */
function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/chats");
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
  older: { height: space(10), alignItems: "center", justifyContent: "center" },
  sheetForm: { paddingHorizontal: space(5), gap: space(3) },
});
