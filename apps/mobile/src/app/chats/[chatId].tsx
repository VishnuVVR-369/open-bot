import type { ChatEntry, ChatSummary } from "@open-bot/api";
import type { ChatStatus } from "@open-bot/domain";
import { isRunActive } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  Archive,
  ArrowDown,
  ChevronRight,
  CloudOff,
  EllipsisVertical,
  MessageCircle,
  Pencil,
  SquarePen,
  Users,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarStack, BotAvatar, StatusLine, type BotActivity } from "@/components/bot-avatar";
import { Composer } from "@/components/chat/composer";
import { KeepTopContext, RowContext, type KeepTop } from "@/components/chat/foldable-text";
import { RunBlock } from "@/components/chat/run-block";
import { UserMessage } from "@/components/chat/user-message";
import { Button } from "@/components/button";
import { ConnectionNotice } from "@/components/connection-notice";
import { Sheet, SheetItem } from "@/components/sheet";
import { Empty, LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { api } from "@/lib/api";
import { errorMessage, isNotFound } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { queryKeys } from "@/lib/query";
import { useChats, useComputerOffline, useNewDirectChat, useTeammates } from "@/lib/queries";
import { headerStatus } from "@/lib/chat-status";
import { namedForTopic } from "@/lib/chats";
import { lastActive } from "@/lib/time";
import { useChat } from "@/lib/use-chat";
import { useChatRunTarget } from "@/lib/use-chat-run-target";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { phoneClock } from "@/lib/phone-clock";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

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
  const { data: teammates } = useTeammates();
  const { data: chatList } = useChats();
  const computerOffline = useComputerOffline();
  const newChat = useNewDirectChat();
  const allBots = teammates ?? members;
  const list = useRef<FlatList<ChatEntry>>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  // Older messages sit under the header (the list is inverted, so they're past its far end).
  const [under, setUnder] = useState(false);
  const extent = useRef({ offset: 0, layout: 0, content: 0 });
  const measure = useCallback((next: Partial<typeof extent.current>) => {
    const current = (extent.current = { ...extent.current, ...next });
    setUnder(current.offset + current.layout < current.content - 1);
  }, []);
  // An opened message would grow from its bottom edge in this inverted list. Pinning older rows
  // keeps its first line where you were reading: Android corrects the scroll natively, after
  // layout and before drawing. The pin must be on screen before the message opens and stay until
  // the opened message is, so each step waits for the commit before it to mount.
  // The pin names a native child of the list: the rows it has rendered, in order, then the footer.
  // Rows it has virtualized away leave no view, though a spacer might, so the pin goes two
  // rendered rows past the message, which is always an older row or the footer.
  const rendered = useRef(new Set<number>()).current;
  const [pin, setPin] = useState<{ child: number; open: () => void } | null>(null);
  useEffect(() => (pin ? afterMount(pin.open) : undefined), [pin]);
  const keepTop = useMemo<KeepTop>(
    () => ({
      open: (row, open) => {
        let before = 0;
        for (const index of rendered) if (index < row) before++;
        setPin({ child: Math.min(before + 2, rendered.size), open });
      },
      opened: () => void afterMount(() => setPin(null)),
    }),
    [rendered],
  );
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
  // The header says what is happening in this chat, never what its teammates do elsewhere (the
  // same words as the web's); what the teammate needs from you in another chat is a link there.
  const status = useMemo(
    () =>
      headerStatus({
        members: members.map(
          (member) => allBots.find((candidate) => candidate.id === member.id) ?? member,
        ),
        group: isGroup,
        chatId,
        computerOnline: !computerOffline,
        chatById: (id) => chatList?.find((entry) => entry.id === id),
      }),
    [members, allBots, isGroup, chatId, computerOffline, chatList],
  );
  const headerActivity: BotActivity = status.activity;
  // An idle direct chat says when its teammate was last active instead; an idle group, nothing.
  const headerText =
    status.activity === "idle"
      ? isGroup
        ? null
        : liveBot?.lastActiveAt
          ? lastActive(liveBot.lastActiveAt)
          : (bot?.role ?? "")
      : status.label;
  const elsewhere = status.elsewhere;
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
  // Waiting on you or paused for the computer, nothing is being done right now to add to or stop.
  const runHeld =
    Boolean(activeRun) && (activeRun?.timeline.status === "waiting" || computerOffline);
  const placeholder = activeRun
    ? runHeld
      ? `Add a note for ${activeName ?? "your teammate"}…`
      : `Add to what ${activeName ?? "your teammate"} is doing…`
    : isGroup
      ? "Message the group, @ to mention"
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
              bot={allBots.find((candidate) => candidate.id === entry.run.botId)}
              bots={allBots}
              superseded={superseded.has(entry.run.id)}
              isGroup={isGroup}
              latest={entry.type === "run" && entry.run.id === latestRunId}
            />
          )}
        </Row>
      );
    },
    [runs, chatId, allBots, superseded, data, isGroup, latestRunId, rendered],
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
                  <Pressable
                    style={styles.headerTitle}
                    disabled={!liveBot}
                    onPress={() => liveBot && router.push(`/teammates/${liveBot.id}`)}
                    accessibilityRole={liveBot ? "button" : undefined}
                    accessibilityHint={liveBot ? `Opens ${liveBot.name}'s profile` : undefined}
                    testID="chat-header"
                  >
                    {isGroup ? (
                      <AvatarStack members={members} ring={colors.background} />
                    ) : (
                      liveBot && (
                        <BotAvatar
                          name={liveBot.name}
                          color={liveBot.color}
                          emoji={liveBot.emoji}
                          size="md"
                          activity={headerActivity}
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
                      {isGroup && status.activity === "idle" ? (
                        // Nothing happening here: who's in it, without a status light.
                        <Text variant="caption" muted numberOfLines={1} testID="chat-status">
                          {members.length} teammates
                        </Text>
                      ) : isGroup ? (
                        <StatusLine activity={headerActivity} size="caption" testID="chat-status">
                          {[`${members.length} teammates`, headerText].filter(Boolean).join(" · ")}
                        </StatusLine>
                      ) : (
                        <StatusLine activity={headerActivity} size="caption" testID="chat-status">
                          {`${chat && namedForTopic(chat, liveBot) ? `${liveBot!.name} · ` : ""}${headerText}`}
                        </StatusLine>
                      )}
                    </View>
                  </Pressable>
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
              ref={list}
              data={data}
              inverted
              maintainVisibleContentPosition={pin ? { minIndexForVisible: pin.child } : undefined}
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
              onScroll={(event) => {
                // Inverted: the offset grows as you scroll back in time.
                const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
                const up = contentOffset.y > 600;
                if (up !== scrolledUp) setScrolledUp(up);
                measure({
                  offset: contentOffset.y,
                  layout: layoutMeasurement.height,
                  content: contentSize.height,
                });
              }}
              onLayout={(event) => measure({ layout: event.nativeEvent.layout.height })}
              onContentSizeChange={(_width, height) => measure({ content: height })}
              scrollEventThrottle={100}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onScrollToIndexFailed={({ index, averageItemLength }) => {
                // Move the render window toward an unmeasured row before trying its exact index.
                list.current?.scrollToOffset({
                  offset: averageItemLength * index,
                  animated: false,
                });
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
                      isGroup
                        ? "Start the conversation"
                        : `Give ${bot?.name ?? "them"} something to do`
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
          </KeepTopContext.Provider>
        )}
        {under && !loading && !gone && (
          // The header stays opaque; a hairline marks where the conversation runs under it.
          <View
            pointerEvents="none"
            style={[styles.hairline, { backgroundColor: colors.border }]}
          />
        )}
        {scrolledUp && !loading && !gone && (
          <View style={styles.latestWrap} pointerEvents="box-none">
            <Pressable
              onPress={() => {
                haptics.tap();
                list.current?.scrollToOffset({ offset: 0, animated: true });
              }}
              accessibilityRole="button"
              accessibilityLabel="Jump to the latest message"
              android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
              style={[
                styles.latest,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  shadowColor: "#000",
                },
              ]}
              testID="jump-to-latest"
            >
              <ArrowDown size={20} color={colors.foreground} />
            </Pressable>
          </View>
        )}
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
            placeholder={placeholder}
            members={members}
            isGroup={isGroup}
            activeRun={
              activeRun ? { id: activeRun.id, botName: activeName ?? "your teammate" } : null
            }
            canStop={!runHeld}
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

/**
 * What's around the chat, under its header: a link to what its teammate needs from you in another
 * chat, and that the computer is offline (a neutral chip, apart from the chat's own status; just
 * "Offline" beside the link, so both fit on a phone).
 */
function ChatContext({
  computerOffline,
  elsewhere,
}: {
  computerOffline: boolean;
  elsewhere: ChatStatus["elsewhere"];
}) {
  const colors = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.context}
      style={{ flexGrow: 0 }}
      testID="chat-context"
    >
      {elsewhere && (
        <Pressable
          onPress={() => {
            haptics.tap();
            router.push(`/chats/${elsewhere.chatId}`);
          }}
          accessibilityRole="link"
          android_ripple={{ color: mix(colors.attention, colors.surface, 0.18) }}
          style={[
            styles.chip,
            styles.link,
            {
              backgroundColor: mix(colors.attention, colors.surface, 0.1),
              borderColor: mix(colors.attention, colors.surface, 0.4),
            },
          ]}
          testID="elsewhere-chip"
        >
          <View style={[styles.chipDot, { backgroundColor: colors.attention }]} />
          <Text
            variant="caption"
            numberOfLines={1}
            style={{ flexShrink: 1, fontWeight: "500", color: colors.attentionInk }}
          >
            {elsewhere.label}
          </Text>
          <ChevronRight size={14} color={colors.attentionInk} />
        </Pressable>
      )}
      {computerOffline && (
        <Pressable
          onPress={() => router.navigate("/computer")}
          accessibilityRole="button"
          accessibilityHint="Opens the computer"
          android_ripple={{ color: colors.muted }}
          style={[styles.chip, { backgroundColor: colors.subtle, borderColor: colors.border }]}
          testID="computer-offline-chip"
        >
          <CloudOff size={14} color={colors.mutedForeground} />
          <Text variant="caption" muted style={{ fontWeight: "500" }}>
            {elsewhere ? "Offline" : "Computer offline"}
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

/** Back where you came from, or to the chats when the chat was opened straight from a link. */
function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace("/chats");
}

/** A row of the chat list, which tells its messages where they are and the list that it's there. */
function Row({
  index,
  rendered,
  children,
}: {
  index: number;
  rendered: Set<number>;
  children: ReactNode;
}) {
  useEffect(() => {
    rendered.add(index);
    return () => void rendered.delete(index);
  }, [index, rendered]);
  return (
    <RowContext.Provider value={index}>
      <View>{children}</View>
    </RowContext.Provider>
  );
}

/**
 * Runs `run` once everything React has committed so far is on screen. Android mounts a commit on
 * the next frame, and the second frame callback comes after that one. Returns a cancel.
 */
function afterMount(run: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}

/** The room between turns (about 24dp): more than inside one, so each exchange reads as a unit. */
function Gap() {
  return <View style={{ height: space(6) }} />;
}

/** A pause this long between two turns earns a time stamp, as in a messaging app. */
const STAMP_GAP_MS = 60 * 60_000;

/**
 * The time stamp above an entry, when it's the first one or comes a while after the one before:
 * "Today 10:29 PM", "Yesterday 9:03 AM", "Mon 2 Nov, 10:29 PM".
 */
function timeStamp(at: string, before: string | undefined): string | null {
  const when = new Date(at);
  if (before && when.getTime() - new Date(before).getTime() < STAMP_GAP_MS) {
    const previous = new Date(before);
    if (previous.toDateString() === when.toDateString()) return null;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  const time = phoneClock(at);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = when.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(when.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}

function TimeStamp({ text }: { text: string }) {
  return (
    <Text
      variant="caption"
      muted
      style={{ textAlign: "center", marginBottom: space(4), fontWeight: "500" }}
    >
      {text}
    </Text>
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
  hairline: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
  menuButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  context: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(4),
    paddingBottom: space(2),
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    height: 32,
    paddingHorizontal: space(3),
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  // A long chat name ends in an ellipsis, so the offline chip beside it stays in view.
  link: { maxWidth: 300 },
  latestWrap: { position: "absolute", right: space(4), bottom: space(3) },
  latest: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  timeline: { paddingHorizontal: space(4), paddingVertical: space(4) },
  // No transform: the inverted list already flips its empty state back (both axes on Android),
  // and a transform here would replace that flip and leave the text mirrored.
  empty: { flex: 1 },
  composer: { paddingHorizontal: space(3), paddingTop: space(2) },
  older: { height: space(10), alignItems: "center", justifyContent: "center" },
  sheetForm: { paddingHorizontal: space(5), gap: space(3) },
});
