import { router } from "expo-router";
import { CalendarClock, Mail, MessagesSquare, SquarePen, Users } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { ConnectionNotice } from "@/components/connection-notice";
import { ListRow, Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { useChats, useTeammates } from "@/lib/queries";
import { chatSubtitle, chatTitle } from "@/lib/chats";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

/** Every conversation, the most recent first. */
export default function Chats() {
  const colors = useColors();
  const chats = useChats();
  const { data: bots = [] } = useTeammates();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await chats.refetch();
    setRefreshing(false);
  }, [chats]);
  const sorted = useMemo(
    () => [...(chats.data ?? [])].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    [chats.data],
  );

  if (chats.isLoading) return <Loading />;
  if (chats.error && !chats.data)
    return <LoadError error={chats.error} onRetry={() => void chats.refetch()} />;
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={sorted}
        keyExtractor={(chat) => chat.id}
        ListHeaderComponent={ConnectionNotice}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(20) }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          <Empty
            icon={<MessagesSquare size={28} color={colors.mutedForeground} />}
            title="No chats yet"
            body="Pick a teammate to start talking."
          />
        }
        renderItem={({ item: chat }) => {
          const bot = bots.find((candidate) => candidate.id === chat.botId);
          const KindIcon =
            chat.kind === "scheduled" ? CalendarClock : chat.kind === "inbox" ? Mail : null;
          return (
            <ListRow
              testID="chat"
              onPress={() => router.push(`/chats/${chat.id}`)}
              leading={
                chat.kind === "group" ? (
                  <View style={[styles.group, { backgroundColor: colors.subtle }]}>
                    <Users size={20} color={colors.mutedForeground} />
                  </View>
                ) : (
                  <View>
                    <BotAvatar
                      name={bot?.name ?? "?"}
                      color={bot?.color ?? "#888888"}
                      emoji={bot?.emoji}
                      size="lg"
                    />
                    {KindIcon && (
                      <View
                        style={[
                          styles.kind,
                          { backgroundColor: colors.surface, borderColor: colors.background },
                        ]}
                      >
                        <KindIcon size={11} color={colors.mutedForeground} />
                      </View>
                    )}
                  </View>
                )
              }
              title={chatTitle(chat, bot)}
              titleStyle={chat.unread ? { fontWeight: "600" } : undefined}
              subtitle={chatSubtitle(chat, bot, bots)}
              aside={
                <View style={styles.aside}>
                  <Text
                    variant="caption"
                    muted={!chat.unread}
                    style={chat.unread ? { fontWeight: "600" } : undefined}
                  >
                    {ago(chat.lastActivityAt)}
                  </Text>
                  {chat.active ? (
                    <View
                      style={[styles.live, { backgroundColor: colors.live }]}
                      testID="chat-live"
                    />
                  ) : chat.unread ? (
                    <View
                      style={[styles.unread, { backgroundColor: colors.foreground }]}
                      testID="chat-unread"
                    />
                  ) : (
                    <View style={styles.live} />
                  )}
                </View>
              }
            />
          );
        }}
      />
      <Pressable
        onPress={() => router.push("/new-chat")}
        accessibilityRole="button"
        accessibilityLabel="New chat"
        android_ripple={{ color: colors.muted, borderless: false }}
        style={[
          styles.fab,
          { backgroundColor: colors.primary, bottom: space(4), shadowColor: "#000000" },
        ]}
        testID="new-chat"
      >
        <SquarePen size={20} color={colors.primaryForeground} />
        <Text variant="label" style={{ color: colors.primaryForeground }}>
          New chat
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    width: 48,
    height: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  kind: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  aside: { alignItems: "flex-end", gap: space(1.5), minWidth: 36 },
  live: { width: 8, height: 8, borderRadius: 4 },
  unread: { width: 8, height: 8, borderRadius: 4 },
  fab: {
    position: "absolute",
    right: space(4),
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: 48,
    paddingHorizontal: space(4.5),
    borderRadius: 16,
    overflow: "hidden",
    elevation: 4,
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
});
