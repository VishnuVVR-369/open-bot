import type { TeammateSummary, ChatSummary } from "@open-bot/api";
import { plainText, type TeammateActivity } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { router, useNavigation } from "expo-router";
import {
  Archive,
  CalendarClock,
  CheckCheck,
  Mail,
  MessagesSquare,
  SquarePen,
} from "lucide-react-native";
import { useLayoutEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  activityText,
  TeammateAvatar,
  GroupAvatar,
  StatusLine,
} from "@/features/teammates/components/teammate-avatar";
import {
  ComputerOfflineNotice,
  ConnectionNotice,
} from "@/features/computer/components/connection-notice";
import { FilterChips } from "@/components/filter-chips";
import { HeaderActions, HeaderButton } from "@/features/home/components/header-actions";
import { Separator } from "@/components/list-row";
import { Sheet, SheetItem } from "@/components/sheet";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { chatSubtitle, chatTitle, namedForTopic } from "@/features/chat/chats";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { queryKeys } from "@/lib/query";
import { useChats } from "@/features/chat/hooks";
import { useComputerOffline } from "@/features/computer/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

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
  teammate: TeammateSummary | undefined,
  computerOffline: boolean,
): TeammateActivity {
  if (!chat.active) return "idle";
  const run = teammate?.activeRun;
  if (run?.chatId === chat.id) {
    if (run.status === "waiting") return "waiting";
    if (run.status === "queued") return "queued";
  }
  return computerOffline ? "paused" : "working";
}

function ChatRow({
  chat,
  teammates,
  computerOffline,
  onLongPress,
}: {
  chat: ChatSummary;
  teammates: TeammateSummary[];
  computerOffline: boolean;
  onLongPress: () => void;
}) {
  const colors = useColors();
  const teammate = teammates.find((candidate) => candidate.id === chat.teammateId);
  const KindIcon = chat.kind === "scheduled" ? CalendarClock : chat.kind === "inbox" ? Mail : null;
  const activity = chatActivity(chat, teammate, computerOffline);
  const live = chat.active ? activityText(activity, teammate?.activeRun?.waitingFor) : null;
  const members = chat.memberIds.flatMap((id) => teammates.filter((entry) => entry.id === id));
  const title = chatTitle(chat, teammate);
  const subtitle = plainText(chatSubtitle(chat, teammate, teammates));
  // Who it's about leads the second line, as "Kit: …" does in a preview.
  const speaker = teammate && namedForTopic(chat, teammate) ? teammate.name : null;
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
          <TeammateAvatar
            name={teammate?.name ?? "?"}
            color={teammate?.color ?? "#888888"}
            emoji={teammate?.emoji}
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
        {/* Every row has the same two lines: the title, then who said what or what's going on. */}
        <View style={styles.titleRow}>
          <Text
            variant="label"
            numberOfLines={1}
            style={[
              { flex: 1, fontSize: 16, lineHeight: 21 },
              chat.unread && { fontWeight: "700" },
            ]}
          >
            {title}
          </Text>
          <Text
            variant="caption"
            muted={!chat.unread}
            style={[styles.when, chat.unread && { fontWeight: "600" }]}
          >
            {ago(chat.lastActivityAt)}
          </Text>
        </View>
        <View style={styles.titleRow}>
          {live ? (
            <View style={{ flex: 1 }}>
              <StatusLine activity={activity} testID="chat-live">
                {speaker ? `${speaker} · ${live}` : live}
              </StatusLine>
            </View>
          ) : (
            <Text
              variant="small"
              numberOfLines={1}
              muted={!chat.unread}
              style={{ flex: 1, fontSize: 14, lineHeight: 19 }}
            >
              {subtitle}
            </Text>
          )}
          {chat.unread && (
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
  const { data: teammates = [] } = useTeammates();
  const [filter, setFilter] = useState<Filter>("all");
  const [menuFor, setMenuFor] = useState<ChatSummary | null>(null);
  const computerOffline = useComputerOffline();
  const navigation = useNavigation();
  // New chat lives in the header, beside search, so nothing floats over the list's rows.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderActions
          leading={
            <HeaderButton
              label="New chat"
              onPress={() => {
                haptics.tap();
                router.push("/new-chat");
              }}
              testID="new-chat"
            >
              <SquarePen size={22} color={colors.foreground} />
            </HeaderButton>
          }
        />
      ),
    });
  }, [navigation, colors.foreground]);
  const { refreshing, onRefresh } = usePullToRefresh(chats.refetch);
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
              <FilterChips options={filters} value={filter} onChange={setFilter} />
            )}
          </View>
        }
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(6) }}
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
            teammates={teammates}
            computerOffline={computerOffline}
            onLongPress={() => setMenuFor(chat)}
          />
        )}
      />
      <Sheet
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={
          menuFor
            ? chatTitle(
                menuFor,
                teammates.find((teammate) => teammate.id === menuFor.teammateId),
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
  // The time sits on the title's first line, even when the title wraps.
  when: { lineHeight: 21 },
  notice: { marginHorizontal: space(4), marginTop: space(2), marginBottom: space(1) },
});
