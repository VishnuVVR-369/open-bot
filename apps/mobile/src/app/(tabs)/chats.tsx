import type { BotSummary, ChatSummary } from "@open-bot/api";
import { plainText } from "@open-bot/shared";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  Archive,
  CalendarClock,
  CheckCheck,
  Mail,
  MessagesSquare,
  SquarePen,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  activityColor,
  activityText,
  BotAvatar,
  GroupAvatar,
  type BotActivity,
} from "@/components/bot-avatar";
import { ComputerOfflineNotice, ConnectionNotice } from "@/components/connection-notice";
import { Separator } from "@/components/list-row";
import { Sheet, SheetItem } from "@/components/sheet";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { chatSubtitle, chatTitle } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { queryKeys } from "@/lib/query";
import { useChats, useComputerOffline, useTeammates } from "@/lib/queries";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "direct", label: "Direct" },
  { key: "group", label: "Groups" },
  { key: "automated", label: "Scheduled" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

function matches(chat: ChatSummary, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return chat.unread;
    case "direct":
      return chat.kind === "direct";
    case "group":
      return chat.kind === "group";
    case "automated":
      return chat.kind === "scheduled" || chat.kind === "inbox";
  }
}

/** What the chat's teammate is doing in this chat, for its avatar; paused while the computer is away. */
function chatActivity(
  chat: ChatSummary,
  bot: BotSummary | undefined,
  computerOffline: boolean,
): BotActivity {
  if (!chat.active) return "idle";
  const run = bot?.activeRun;
  if (run?.chatId === chat.id) {
    if (run.status === "waiting") return "waiting";
    if (run.status === "queued") return "queued";
  }
  return computerOffline ? "paused" : "working";
}

function ChatRow({
  chat,
  bots,
  computerOffline,
  onLongPress,
}: {
  chat: ChatSummary;
  bots: BotSummary[];
  computerOffline: boolean;
  onLongPress: () => void;
}) {
  const colors = useColors();
  const bot = bots.find((candidate) => candidate.id === chat.botId);
  const KindIcon = chat.kind === "scheduled" ? CalendarClock : chat.kind === "inbox" ? Mail : null;
  const activity = chatActivity(chat, bot, computerOffline);
  const live = activityText(activity, bot?.activeRun?.waitingFor);
  const members = chat.memberIds.flatMap((id) => bots.filter((entry) => entry.id === id));
  const title = chatTitle(chat, bot);
  const subtitle = plainText(chatSubtitle(chat, bot, bots));
  return (
    <Pressable
      onPress={() => router.push(`/chats/${chat.id}`)}
      onLongPress={() => {
        haptics.press();
        onLongPress();
      }}
      android_ripple={{ color: colors.muted }}
      accessibilityRole="button"
      accessibilityLabel={[
        title,
        live,
        chat.unread ? "unread" : null,
        subtitle,
        ago(chat.lastActivityAt),
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint="Hold for more options"
      style={styles.row}
      testID="chat"
    >
      <View>
        {chat.kind === "group" ? (
          <GroupAvatar members={members} />
        ) : (
          <BotAvatar
            name={bot?.name ?? "?"}
            color={bot?.color ?? "#888888"}
            emoji={bot?.emoji}
            size="lg"
            activity={activity}
          />
        )}
        {KindIcon && (
          <View
            style={[
              styles.kind,
              { backgroundColor: colors.surface, borderColor: colors.background },
            ]}
          >
            <KindIcon size={13} color={colors.foreground} />
          </View>
        )}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.titleRow}>
          <Text
            variant="label"
            numberOfLines={1}
            style={[{ flex: 1, fontSize: 16 }, chat.unread && { fontWeight: "700" }]}
          >
            {title}
          </Text>
          <Text
            variant="caption"
            muted={!chat.unread}
            style={chat.unread ? { fontWeight: "600" } : undefined}
          >
            {ago(chat.lastActivityAt)}
          </Text>
        </View>
        <View style={styles.titleRow}>
          {live ? (
            <Text
              variant="small"
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 14,
                fontWeight: "500",
                color: activityColor(activity, colors),
              }}
              testID="chat-live"
            >
              {live}
            </Text>
          ) : (
            <Text
              variant="small"
              numberOfLines={2}
              muted={!chat.unread}
              style={{ flex: 1, fontSize: 14, lineHeight: 19 }}
            >
              {subtitle}
            </Text>
          )}
          {chat.unread && !chat.active && (
            <View
              style={[styles.unread, { backgroundColor: colors.foreground }]}
              testID="chat-unread"
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** Every conversation, the most recent first, with filters and a hold menu. */
export default function Chats() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const chats = useChats();
  const { data: bots = [] } = useTeammates();
  const [filter, setFilter] = useState<Filter>("all");
  const [menuFor, setMenuFor] = useState<ChatSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const computerOffline = useComputerOffline();
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await chats.refetch();
    setRefreshing(false);
  }, [chats]);
  const sorted = useMemo(
    () => [...(chats.data ?? [])].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [chats.data],
  );
  const shown = useMemo(() => sorted.filter((chat) => matches(chat, filter)), [sorted, filter]);
  // Only offer the filters that would show something.
  const filters = FILTERS.filter(
    (entry) =>
      entry.key === "all" || entry.key === filter || sorted.some((c) => matches(c, entry.key)),
  );

  const markRead = async (chat: ChatSummary) => {
    setMenuFor(null);
    const result = await safe(api.chats.markRead({ chatId: chat.id }));
    if (result.error) Alert.alert("Couldn't mark it read", errorMessage(result.error));
    else void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
  };
  const archive = (chat: ChatSummary) => {
    setMenuFor(null);
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
            haptics.success();
            animateLayout();
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
          },
        },
      ],
    );
  };

  if (chats.isLoading) return <Loading />;
  if (chats.error && !chats.data)
    return <LoadError error={chats.error} onRetry={() => void chats.refetch()} />;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={shown}
        keyExtractor={(chat) => chat.id}
        ListHeaderComponent={
          <View>
            <ConnectionNotice />
            <ComputerOfflineNotice style={styles.notice} />
            {sorted.length > 0 && filters.length > 1 && (
              <FlatList
                horizontal
                data={filters}
                keyExtractor={(entry) => entry.key}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filters}
                renderItem={({ item: entry }) => {
                  const selected = entry.key === filter;
                  return (
                    <Pressable
                      onPress={() => {
                        haptics.tap();
                        animateLayout();
                        setFilter(entry.key);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={[
                        styles.chip,
                        selected
                          ? { backgroundColor: colors.primary, borderColor: colors.primary }
                          : { backgroundColor: colors.surface, borderColor: colors.border },
                      ]}
                    >
                      <Text
                        variant="small"
                        style={{
                          fontWeight: "500",
                          color: selected ? colors.primaryForeground : colors.foreground,
                        }}
                      >
                        {entry.label}
                      </Text>
                    </Pressable>
                  );
                }}
              />
            )}
          </View>
        }
        ItemSeparatorComponent={Separator}
        // Room for the New chat button and 24dp more, so the last chat clears it.
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 56 + space(4) + space(6) }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          filter === "all" ? (
            <Empty
              icon={<MessagesSquare size={28} color={colors.mutedForeground} />}
              title="No chats yet"
              body="Pick a teammate to start talking."
            />
          ) : (
            <Empty
              icon={<CheckCheck size={28} color={colors.mutedForeground} />}
              title={filter === "unread" ? "You're all caught up" : "Nothing here"}
              body={filter === "unread" ? "No unread replies." : "No chats of this kind yet."}
            />
          )
        }
        renderItem={({ item: chat }) => (
          <ChatRow
            chat={chat}
            bots={bots}
            computerOffline={computerOffline}
            onLongPress={() => setMenuFor(chat)}
          />
        )}
      />
      <Pressable
        onPress={() => {
          haptics.tap();
          router.push("/new-chat");
        }}
        accessibilityRole="button"
        accessibilityLabel="New chat"
        android_ripple={{ color: colors.muted, borderless: false }}
        style={[styles.fab, { backgroundColor: colors.primary, shadowColor: "#000000" }]}
        testID="new-chat"
      >
        <SquarePen size={22} color={colors.primaryForeground} />
      </Pressable>
      <Sheet
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={
          menuFor
            ? chatTitle(
                menuFor,
                bots.find((bot) => bot.id === menuFor.botId),
              )
            : undefined
        }
        testID="chat-row-menu"
      >
        {menuFor?.unread && (
          <SheetItem
            icon={<CheckCheck size={20} color={colors.foreground} />}
            label="Mark as read"
            onPress={() => void markRead(menuFor)}
          />
        )}
        {menuFor && (menuFor.kind === "direct" || menuFor.kind === "group") && (
          <SheetItem
            icon={<Archive size={20} color={colors.destructive} />}
            label="Archive"
            destructive
            onPress={() => archive(menuFor)}
          />
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 76,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  filters: {
    paddingHorizontal: space(4),
    paddingTop: space(2),
    paddingBottom: space(2),
    gap: space(2),
  },
  chip: {
    minHeight: 36,
    // Narrow enough that every filter fits a phone's width without running off the edge.
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
  kind: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  unread: { width: 9, height: 9, borderRadius: 5 },
  // The standard 56dp compose button: big enough to find, small enough to keep off the previews.
  fab: {
    position: "absolute",
    right: space(4),
    bottom: space(4),
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    overflow: "hidden",
    elevation: 6,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  notice: { marginHorizontal: space(4), marginTop: space(2), marginBottom: space(1) },
});
