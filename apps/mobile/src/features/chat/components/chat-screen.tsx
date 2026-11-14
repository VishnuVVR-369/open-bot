import type { ChatEntry } from "@open-bot/api";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { EllipsisVertical, MessageCircle } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { ChatContext } from "@/features/chat/components/chat-context";
import { ChatEmpty } from "@/features/chat/components/chat-empty";
import { ChatMenu } from "@/features/chat/components/chat-menu";
import { Row } from "@/features/chat/components/chat-row";
import { ChatTitle } from "@/features/chat/components/chat-title";
import { Composer } from "@/features/chat/components/composer";
import { KeepTopContext } from "@/features/chat/components/foldable-text";
import { JumpToLatest } from "@/features/chat/components/jump-to-latest";
import { RunBlock } from "@/features/chat/components/run-block";
import { TimeStamp } from "@/features/chat/components/time-stamp";
import { UserMessage } from "@/features/chat/components/user-message";
import { ConnectionNotice } from "@/features/computer/components/connection-notice";
import { LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import {
  composerPlaceholder,
  headerText,
  latestActiveRun,
  supersededRuns,
  timelineRows,
} from "@/features/chat/chat-screen";
import { headerStatus } from "@/features/chat/chat-status";
import { chatTitle } from "@/features/chat/chats";
import { isNotFound } from "@/lib/errors";
import { useChats, useNewDirectChat } from "@/features/chat/hooks";
import { useComputerOffline } from "@/features/computer/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { timeStamp } from "@/features/chat/time-stamp";
import { useChat } from "@/features/chat/use-chat";
import { useChatListScroll } from "@/features/chat/use-chat-list-scroll";
import { useChatRunTarget } from "@/features/chat/use-chat-run-target";
import { useKeepTop } from "@/features/chat/use-keep-top";
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
  const gone = isNotFound(error);
  const { data: roster } = useTeammates();
  const { data: chatList } = useChats();
  const computerOffline = useComputerOffline();
  const newChat = useNewDirectChat();
  const team = roster ?? members;
  const { keepTop, rendered, pinnedChild } = useKeepTop();
  const scroll = useChatListScroll(chatId, runParam);

  const isGroup = chat?.kind === "group";
  const teammate = !isGroup ? members[0] : undefined;
  const liveTeammate = teammate && (team.find((entry) => entry.id === teammate.id) ?? teammate);
  // The header says what is happening in this chat, never what its teammates do elsewhere (the
  // same words as the web's); what the teammate needs from you in another chat is a link there.
  const status = useMemo(
    () =>
      headerStatus({
        members: members.map((member) => team.find((entry) => entry.id === member.id) ?? member),
        group: isGroup,
        chatId,
        computerOnline: !computerOffline,
        chatById: (id) => chatList?.find((entry) => entry.id === id),
      }),
    [members, team, isGroup, chatId, computerOffline, chatList],
  );
  const elsewhere = status.elsewhere;

  const data = useMemo(() => timelineRows(entries, runs), [entries, runs]);
  const activeRun = useMemo(() => latestActiveRun(runs), [runs]);
  const activeName = activeRun && team.find((entry) => entry.id === activeRun.botId)?.name;
  // Waiting on you or paused for the computer, nothing is being done right now to add to or stop.
  const runHeld =
    Boolean(activeRun) && (activeRun?.timeline.status === "waiting" || computerOffline);
  const superseded = useMemo(() => supersededRuns(entries), [entries]);

  useChatRunTarget({
    chatId,
    runId: runParam,
    items: data,
    oldest: entries[0]?.at,
    hasMore,
    loading: loading || loadingOlder || Boolean(error),
    loadOlder,
    scrollToIndex: scroll.scrollToRun,
  });

  // The newest turn shows its reply actions; older ones open them with a long press.
  const latestRunId = useMemo(() => data.find((entry) => entry.type === "run")?.run.id, [data]);

  const renderItem = useCallback(
    ({ item: entry, index }: { item: ChatEntry; index: number }) => {
      // The list runs newest first, so the entry before this one in time is the next one.
      const older = data[index + 1];
      const stamp = timeStamp(entry.at, older?.at);
      return (
        <Row index={index} rendered={rendered}>
          {stamp && <TimeStamp text={stamp} />}
          {entry.type === "message" ? (
            <UserMessage message={entry.message} />
          ) : (
            <RunBlock
              run={runs[entry.run.id] ?? entry.run}
              chatId={chatId}
              bot={team.find((candidate) => candidate.id === entry.run.botId)}
              bots={team}
              superseded={superseded.has(entry.run.id)}
              isGroup={isGroup}
              latest={entry.type === "run" && entry.run.id === latestRunId}
            />
          )}
        </Row>
      );
    },
    [runs, chatId, team, superseded, data, isGroup, latestRunId, rendered],
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
                  <ChatTitle
                    chat={chat}
                    teammate={liveTeammate}
                    members={members}
                    title={chatTitle(chat, teammate)}
                    activity={status.activity}
                    text={headerText({
                      status,
                      isGroup,
                      lastActiveAt: liveTeammate?.lastActiveAt,
                      role: teammate?.role,
                    })}
                  />
                ),
          headerRight: () =>
            chat && !gone && (chat.kind === "direct" || chat.kind === "group") ? (
              <Pressable
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Chat options"
                android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
                style={styles.menuButton}
                testID="chat-menu"
              >
                <EllipsisVertical size={22} color={colors.foreground} />
              </Pressable>
            ) : null,
        }}
      />
      {chat && !gone && (computerOffline || elsewhere) && (
        <ChatContext computerOffline={computerOffline} elsewhere={elsewhere} />
      )}
      {Boolean(olderError) && (
        <View style={{ padding: space(3), gap: space(2) }}>
          <Text variant="small" style={{ color: colors.destructive }}>
            Couldn't load earlier messages.
          </Text>
          <Button title="Retry" variant="outline" onPress={() => void loadOlder()} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        {loading ? (
          <Loading />
        ) : gone ? (
          <NotFound
            icon={MessageCircle}
            title="This chat is unavailable"
            body="It may have been deleted, or the link may be wrong."
            action="Go to Chats"
            onAction={() => router.navigate("/chats")}
          />
        ) : error || !chat ? (
          <LoadError
            title="Couldn't load this chat"
            error={error}
            onRetry={() => void refetch()}
            onBack={goBack}
          />
        ) : (
          <KeepTopContext.Provider value={keepTop}>
            <FlatList
              ref={scroll.list}
              data={data}
              inverted
              maintainVisibleContentPosition={
                pinnedChild !== null ? { minIndexForVisible: pinnedChild } : undefined
              }
              // Clipping detaches rows off screen, which would shift the pin's child index.
              removeClippedSubviews={false}
              keyExtractor={(entry) => (entry.type === "message" ? entry.message.id : entry.run.id)}
              renderItem={renderItem}
              ItemSeparatorComponent={Gap}
              ListFooterComponent={
                // Room for the spinner only while there's more to load, so a short chat starts at the top.
                <View style={hasMore || loadingOlder ? styles.older : undefined}>
                  {loadingOlder && (
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  )}
                </View>
              }
              onEndReached={() => {
                if (hasMore) void loadOlder();
              }}
              onEndReachedThreshold={0.4}
              // A short conversation starts at the top, under the header, not at the composer:
              // the list is inverted, so "flex-end" is the top.
              contentContainerStyle={[
                styles.timeline,
                data.length === 0 ? { flex: 1 } : { flexGrow: 1, justifyContent: "flex-end" },
              ]}
              onScroll={scroll.onScroll}
              onLayout={scroll.onLayout}
              onContentSizeChange={scroll.onContentSizeChange}
              scrollEventThrottle={100}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onScrollToIndexFailed={scroll.onScrollToIndexFailed}
              ListEmptyComponent={<ChatEmpty teammate={teammate} isGroup={isGroup} />}
            />
          </KeepTopContext.Provider>
        )}
        {scroll.under && !loading && !gone && (
          // The header stays opaque; a hairline marks where the conversation runs under it.
          <View
            pointerEvents="none"
            style={[styles.hairline, { backgroundColor: colors.border }]}
          />
        )}
        {scroll.scrolledUp && !loading && !gone && <JumpToLatest onPress={scroll.scrollToLatest} />}
      </View>
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
            placeholder={composerPlaceholder({
              activeName: activeRun ? activeName : null,
              held: runHeld,
              isGroup,
              name: teammate?.name,
            })}
            members={members}
            isGroup={isGroup}
            activeRun={
              activeRun ? { id: activeRun.id, botName: activeName ?? "your teammate" } : null
            }
            canStop={!runHeld}
            onSent={(message) => {
              addSent(message);
              scroll.scrollToLatest();
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
            if (chat.kind === "direct" && teammate) newChat.mutate(teammate.id);
            else router.push("/new-chat");
          }}
        />
      )}
    </View>
  );
}

/** Back where you came from, or to the chats when the chat was opened straight from a link. */
function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/chats");
}

/** The room between turns (about 24dp): more than inside one, so each exchange reads as a unit. */
function Gap() {
  return <View style={{ height: space(6) }} />;
}

const styles = StyleSheet.create({
  hairline: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
  menuButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  timeline: { paddingHorizontal: space(4), paddingVertical: space(4) },
  composer: { paddingHorizontal: space(3), paddingTop: space(2) },
  older: { height: space(10), alignItems: "center", justifyContent: "center" },
});
