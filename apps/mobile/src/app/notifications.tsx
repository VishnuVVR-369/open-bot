import type { NotificationView } from "@open-bot/api";
import { plainText } from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useFocusEffect } from "expo-router";
import {
  AlertTriangle,
  Bell,
  CircleDollarSign,
  Hand,
  MessageSquare,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { notificationHref } from "@/lib/links";
import { useHome, useNotifications, useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

const ICONS: Record<string, LucideIcon> = {
  approval: ShieldAlert,
  takeover_request: Hand,
  run_failed: AlertTriangle,
  cap_reached: CircleDollarSign,
  bot_message: MessageSquare,
  run_finished: MessageSquare,
};

/** What teammates told you, newest first, as the bell on the web shows it. */
export default function Notifications() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const query = useNotifications();
  const { data: bots = [] } = useTeammates();
  const [refreshing, setRefreshing] = useState(false);
  const notifications = query.data ?? [];
  const unread = notifications.filter((notification) => !notification.readAt);
  const { data: home } = useHome();
  // What the bell counts can include ones too old for the list.
  const anyUnread = unread.length > 0 || (home?.unreadNotifications ?? 0) > 0;
  const seen = useRef({ newest: notifications[0]?.id, anyUnread });
  seen.current = { newest: notifications[0]?.id, anyUnread };

  /** One notification, or (by default) everything up to the newest one in the list. */
  const markRead = useCallback(
    (ids?: string[]) => {
      const through = seen.current.newest;
      if (!ids && !through) return;
      const now = new Date().toISOString();
      queryClient.setQueryData<NotificationView[]>(queryKeys.notifications, (current) =>
        current?.map((notification) =>
          !notification.readAt && (!ids || ids.includes(notification.id))
            ? { ...notification, readAt: now }
            : notification,
        ),
      );
      void api.notifications
        .markRead(ids ? { ids } : { through })
        .catch(() => {})
        .finally(() => void queryClient.invalidateQueries({ queryKey: queryKeys.home }));
    },
    [queryClient],
  );

  // Leaving the list means you've seen what was in it, and what's older.
  useFocusEffect(
    useCallback(
      () => () => {
        if (seen.current.anyUnread) markRead();
      },
      [markRead],
    ),
  );

  if (query.isLoading) return <Loading />;
  if (query.error && !query.data)
    return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () =>
            anyUnread ? (
              <Pressable
                onPress={() => markRead()}
                hitSlop={10}
                accessibilityRole="button"
                testID="mark-all-read"
              >
                <Text variant="label">Mark all read</Text>
              </Pressable>
            ) : null,
        }}
      />
      <FlatList
        data={notifications}
        keyExtractor={(notification) => notification.id}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space(6) }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await query.refetch();
              setRefreshing(false);
            }}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: colors.border }]} />
        )}
        ListEmptyComponent={
          <Empty
            icon={<Bell size={28} color={colors.mutedForeground} />}
            title="Nothing yet"
            body="When a teammate finishes something or needs you, it shows up here."
          />
        }
        renderItem={({ item: notification }) => {
          const bot = bots.find((candidate) => candidate.id === notification.botId);
          const isUnread = !notification.readAt;
          const Icon = ICONS[notification.kind] ?? Bell;
          const body = plainText(notification.body);
          return (
            <Pressable
              onPress={() => {
                if (isUnread) markRead([notification.id]);
                router.push(notificationHref(notification));
              }}
              android_ripple={{ color: colors.muted }}
              style={[
                styles.row,
                isUnread && { backgroundColor: mix(colors.foreground, colors.background, 0.025) },
              ]}
              accessibilityRole="button"
              testID="notification"
            >
              {bot ? (
                <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />
              ) : (
                <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
                  <Icon size={18} color={colors.mutedForeground} />
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.titleRow}>
                  <Text
                    variant="label"
                    numberOfLines={2}
                    style={[{ flex: 1 }, !isUnread && { fontWeight: "400" }]}
                  >
                    {notification.title}
                  </Text>
                  <Text variant="caption" muted>
                    {ago(notification.createdAt)}
                  </Text>
                </View>
                {body ? (
                  <Text variant="small" muted numberOfLines={3}>
                    {body}
                  </Text>
                ) : null}
              </View>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: isUnread ? colors.foreground : "transparent" },
                ]}
              />
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
  },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: space(2) },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space(4) + 36 + space(3) },
});
