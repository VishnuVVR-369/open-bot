import type { BotSummary, NotificationView } from "@open-bot/api";
import { plainText } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useFocusEffect } from "expo-router";
import {
  AlertTriangle,
  Bell,
  Check,
  CircleDollarSign,
  Hand,
  MessageSquare,
  ShieldAlert,
  Smartphone,
  type LucideIcon,
} from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import {
  ApprovalStatusChip,
  AvatarBadge,
  ON_ATTENTION,
} from "@/features/approvals/components/approval-parts";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { FilterChips } from "@/components/filter-chips";
import { Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { groupByDay } from "@/lib/day-groups";
import { haptics } from "@/lib/haptics";
import { notificationHref } from "@/lib/links";
import { phoneClock } from "@/lib/phone-clock";
import {
  collapseRepeats,
  notificationState,
  notificationText,
  stillNeedsYou,
  type NotificationState,
} from "@/features/notifications/notification-groups";
import { useApprovals } from "@/features/approvals/hooks";
import { useHome } from "@/features/home/hooks";
import { useNotifications } from "@/features/notifications/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

const ICONS: Record<string, LucideIcon> = {
  approval: ShieldAlert,
  takeover_request: Hand,
  run_failed: AlertTriangle,
  cap_reached: CircleDollarSign,
  egress_unanswered: Smartphone,
  bot_message: MessageSquare,
  run_finished: MessageSquare,
};

/** Kinds that need you, which get an amber mark, and failures, which get a red one. */
const NEEDS_YOU = new Set(["approval", "takeover_request", "cap_reached", "egress_unanswered"]);
const FAILED = new Set(["run_failed"]);

const AVATAR = 36;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
] as const;

/**
 * Who it's from: the teammate's face, or a tile for the app itself. The badge says what kind of
 * event it was. It never shows what the teammate is doing now: the row is about then, not now.
 */
function Leading({ notification, bot }: { notification: NotificationView; bot?: BotSummary }) {
  const colors = useColors();
  const Icon = ICONS[notification.kind] ?? Bell;
  const signal = NEEDS_YOU.has(notification.kind)
    ? { fill: colors.attention, ink: colors.attentionInk }
    : FAILED.has(notification.kind)
      ? { fill: colors.destructive, ink: colors.destructive }
      : null;
  if (!bot)
    return (
      <View
        style={[
          styles.tile,
          { backgroundColor: signal ? mix(signal.fill, colors.surface, 0.14) : colors.subtle },
        ]}
      >
        <Icon size={20} color={signal ? signal.ink : colors.foreground} />
      </View>
    );
  const avatar = <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />;
  if (!signal) return avatar;
  return (
    <AvatarBadge
      tint={signal.fill}
      ink={colors.background}
      badge={
        <Icon size={11} color={signal.fill === colors.attention ? ON_ATTENTION : colors.surface} />
      }
    >
      {avatar}
    </AvatarBadge>
  );
}

/** What teammates told you, newest first, as the bell on the web shows it. */
export default function Notifications() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const queryClient = useQueryClient();
  const query = useNotifications();
  const { data: bots = [] } = useTeammates();
  const { refreshing, onRefresh } = usePullToRefresh(query.refetch);
  const notifications = useMemo(() => query.data ?? [], [query.data]);
  const unread = notifications.filter((notification) => !notification.readAt);
  const { data: home } = useHome();
  // What the bell counts can include ones too old for the list.
  const anyUnread = unread.length > 0 || (home?.unreadNotifications ?? 0) > 0;
  const { data: approvals = [] } = useApprovals();
  const [filter, setFilter] = useState<"all" | "needs">("all");
  // Where each request stands now: pending, or how it was decided.
  const states = useMemo(() => {
    const result = new Map<string, NotificationState | null>();
    for (const notification of notifications)
      result.set(
        notification.id,
        notificationState(notification, approvals, home?.takeoverRequests ?? []),
      );
    return result;
  }, [notifications, approvals, home?.takeoverRequests]);
  const sections = useMemo(
    () =>
      groupByDay(
        collapseRepeats(
          filter === "needs"
            ? notifications.filter((notification) =>
                stillNeedsYou(notification, states.get(notification.id) ?? null),
              )
            : notifications,
        ),
        (row) => row.items[0]!.createdAt,
      ),
    [notifications, filter, states],
  );
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
                onPress={() => {
                  haptics.tap();
                  markRead();
                }}
                hitSlop={4}
                style={styles.headerAction}
                accessibilityRole="button"
                testID="mark-all-read"
              >
                <Text variant="label">Mark all read</Text>
              </Pressable>
            ) : null,
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: bottom }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[colors.foreground]}
            progressBackgroundColor={colors.surface}
          />
        }
        renderSectionHeader={({ section }) => (
          <Text variant="overline" muted style={styles.section} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        ItemSeparatorComponent={() => <Separator inset={space(4) + AVATAR + space(3)} />}
        ListHeaderComponent={
          notifications.length > 0 ? (
            <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
          ) : undefined
        }
        ListEmptyComponent={
          filter === "needs" ? (
            <Empty
              icon={<Check size={28} color={colors.mutedForeground} />}
              title="Nothing needs you"
              body="Requests waiting on you show up here until you decide them."
            />
          ) : (
            <Empty
              icon={<Bell size={28} color={colors.mutedForeground} />}
              title="Nothing yet"
              body="When a teammate finishes something or needs you, it shows up here."
            />
          )
        }
        renderItem={({ item: row, section }) => {
          const notification = row.items[0]!;
          // The header already says "Yesterday", so its rows give the time of day instead.
          const when =
            section.title === "Yesterday"
              ? phoneClock(notification.createdAt)
              : ago(notification.createdAt);
          const bot = bots.find((candidate) => candidate.id === notification.botId);
          const unreadIds = row.items.filter((item) => !item.readAt).map((item) => item.id);
          const isUnread = unreadIds.length > 0;
          const { title, body: rawBody } = notificationText(notification);
          const body = plainText(rawBody);
          const count = row.items.length;
          const state = states.get(notification.id) ?? null;
          const stateLabel = !state
            ? null
            : state.status !== "pending"
              ? undefined
              : state.kind === "takeover"
                ? "Takeover pending"
                : "Approval pending";
          return (
            <Pressable
              onPress={() => {
                if (isUnread) markRead(unreadIds);
                router.push(notificationHref(notification));
              }}
              android_ripple={{ color: colors.muted }}
              style={[
                styles.row,
                isUnread && { backgroundColor: mix(colors.foreground, colors.background, 0.035) },
              ]}
              accessibilityRole="button"
              accessibilityLabel={[
                isUnread ? "Unread" : null,
                title,
                count > 1 ? `${count} times` : null,
                body,
                state ? (stateLabel ?? state.status) : null,
                when,
              ]
                .filter(Boolean)
                .join(", ")}
              testID="notification"
            >
              <Leading notification={notification} bot={bot} />
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.titleRow}>
                  <Text
                    variant="label"
                    numberOfLines={2}
                    style={[styles.title, { fontWeight: isUnread ? "600" : "400" }]}
                  >
                    {title}
                  </Text>
                  {count > 1 && (
                    <View style={[styles.count, { backgroundColor: colors.subtle }]}>
                      <Text variant="caption" style={{ fontWeight: "600" }}>
                        ×{count}
                      </Text>
                    </View>
                  )}
                  <View style={styles.when}>
                    <Text
                      variant="caption"
                      muted={!isUnread}
                      style={isUnread ? { fontWeight: "600" } : undefined}
                    >
                      {when}
                    </Text>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: isUnread ? colors.foreground : "transparent" },
                      ]}
                    />
                  </View>
                </View>
                {body ? (
                  <Text variant="small" muted numberOfLines={2}>
                    {body}
                  </Text>
                ) : null}
                {state && (
                  <View style={styles.state}>
                    <ApprovalStatusChip
                      status={state.status}
                      size="sm"
                      label={stateLabel ?? undefined}
                    />
                  </View>
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: space(4),
    paddingTop: space(5),
    paddingBottom: space(2),
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: space(2) },
  state: { flexDirection: "row", marginTop: space(1.5) },
  title: { flex: 1 },
  // The time and the unread dot share the title's first line.
  when: { flexDirection: "row", alignItems: "center", gap: space(1.5), height: 20 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  count: {
    borderRadius: radius.full,
    paddingHorizontal: space(1.5),
    height: 20,
    justifyContent: "center",
  },
  tile: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  headerAction: { minHeight: 48, justifyContent: "center", paddingHorizontal: space(2) },
});
