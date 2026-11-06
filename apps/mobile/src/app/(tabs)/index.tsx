import type {
  ActivityItem,
  BotSummary,
  BriefingItem,
  ChatSummary,
  Home,
  PageSummary,
} from "@open-bot/api";
import { isRunActive, plainText } from "@open-bot/shared";
import { router, type Href } from "expo-router";
import {
  AlertCircle,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Crown,
  Eye,
  Hand,
  History,
  Mail,
  ShieldAlert,
  Sparkles,
  Users,
  Webhook,
  X,
} from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { BotAvatar, botActivity, GroupAvatar } from "@/components/bot-avatar";
import { ConnectionNotice } from "@/components/connection-notice";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { usePresence } from "@/lib/presence";
import { PageMenu, PageRow } from "@/components/page-row";
import { sortPages } from "@/lib/pages";
import { useChats, useHome, useNewDirectChat, usePages, useTeammates } from "@/lib/queries";
import { phoneDayClock } from "@/lib/phone-clock";
import { screenHref } from "@/lib/screens";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

function greeting(name: string, hour = new Date().getHours()) {
  const part =
    hour < 5
      ? "Good night"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const chatHref = (chatId: string, runId?: string | null): Href =>
  runId ? `/chats/${chatId}?run=${runId}` : `/chats/${chatId}`;

/** How many recent turns from groups and automations Home shows. */
const RECENT = 4;

/** The line under the greeting: what's going on, in a few words. */
function statusLine(home: Home, bots: BotSummary[]): string {
  const needs = home.pendingApprovals + home.takeoverRequests.length;
  const working = bots.filter((bot) => botActivity(bot) === "working");
  if (needs > 0) return `${plural(needs, "thing")} ${needs === 1 ? "needs" : "need"} you.`;
  if (working.length === 1) return `${working[0]!.name} is working on something.`;
  if (working.length > 1) return `${plural(working.length, "teammate")} are working right now.`;
  return "All quiet. Your teammates are ready when you are.";
}

/** Something that needs you, in a tinted card of its own, with who's asking. */
function Callout({
  leading,
  onPress,
  children,
  action,
  testID,
}: {
  leading: ReactNode;
  onPress: () => void;
  children: ReactNode;
  action: string;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      android_ripple={{ color: mix(colors.attention, colors.surface, 0.18) }}
      style={[
        styles.callout,
        {
          borderColor: mix(colors.attention, colors.surface, 0.5),
          backgroundColor: mix(colors.attention, colors.surface, 0.09),
        },
      ]}
      testID={testID}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>{children}</View>
      <View style={[styles.calloutAction, { backgroundColor: colors.attention }]}>
        <Text variant="small" style={{ color: "#1A1200", fontWeight: "600" }}>
          {action}
        </Text>
      </View>
    </Pressable>
  );
}

function NeedsYou({ home, bots }: { home: Home; bots: BotSummary[] }) {
  const colors = useColors();
  const proposals = home.proposals.flatMap((proposal) => {
    const bot = bots.find((entry) => entry.id === proposal.botId);
    return bot ? [{ ...proposal, bot }] : [];
  });
  // Who is waiting on an approval, from the teammates' live state.
  const asking = bots.filter(
    (bot) => bot.activeRun?.status === "waiting" && bot.activeRun.waitingFor === "approval",
  );
  if (home.pendingApprovals === 0 && home.takeoverRequests.length === 0 && proposals.length === 0)
    return null;
  return (
    <Section title="Needs you">
      <View style={{ gap: space(2) }}>
        {home.takeoverRequests.map((request) => {
          const bot = bots.find((entry) => entry.id === request.botId);
          return (
            <Callout
              key={request.id}
              leading={
                bot ? (
                  <BotAvatar {...bot} size="md" />
                ) : (
                  <Hand size={20} color={colors.attentionInk} />
                )
              }
              onPress={() => router.push(screenHref(request.screenId, request.id))}
              action="Open"
              testID="takeover-request"
            >
              <Text variant="label">{request.botName} needs you to take over</Text>
              <Text variant="small" muted numberOfLines={2}>
                {request.reason}
              </Text>
            </Callout>
          );
        })}
        {home.pendingApprovals > 0 && (
          <Callout
            leading={
              asking.length === 1 ? (
                <BotAvatar {...asking[0]!} size="md" />
              ) : asking.length > 1 ? (
                <GroupAvatar
                  members={asking}
                  size="md"
                  ring={mix(colors.attention, colors.surface, 0.09)}
                />
              ) : (
                <View
                  style={[
                    styles.mark,
                    { backgroundColor: mix(colors.attention, colors.surface, 0.22) },
                  ]}
                >
                  <ShieldAlert size={20} color={colors.attentionInk} />
                </View>
              )
            }
            onPress={() => router.navigate("/approvals")}
            action="Review"
            testID="pending-approvals"
          >
            <Text variant="label">
              {home.pendingApprovals === 1
                ? "1 action waiting for your OK"
                : `${home.pendingApprovals} actions waiting for your OK`}
            </Text>
            {asking.length > 0 && (
              <Text variant="small" muted numberOfLines={1}>
                From {asking.map((bot) => bot.name).join(", ")}
              </Text>
            )}
          </Callout>
        )}
        {proposals.map((proposal) => (
          <View
            key={proposal.id}
            style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Sparkles size={18} color={colors.mutedForeground} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label">{proposal.bot.name} suggests new instructions</Text>
              <Text variant="small" muted>
                Review them in open-bot on a computer.
              </Text>
            </View>
          </View>
        ))}
      </View>
    </Section>
  );
}

const TRIGGER_ICONS = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
} as const;

/** The most replies shown for each teammate in the briefing. */
const PER_BOT = 3;

function Briefing({
  items,
  bots,
  since,
}: {
  items: BriefingItem[];
  bots: BotSummary[];
  since: string;
}) {
  const colors = useColors();
  const { dismiss } = usePresence();
  if (items.length === 0) return null;
  const byBot = new Map<string, BriefingItem[]>();
  // Newest first, but what failed comes before what went fine.
  const ordered = [...items].sort(
    (a, b) => Number(b.status === "failed") - Number(a.status === "failed"),
  );
  for (const item of ordered) byBot.set(item.botId, [...(byBot.get(item.botId) ?? []), item]);
  const failed = items.filter((item) => item.status === "failed").length;
  const done = items.length - failed;
  return (
    <View
      style={[styles.briefing, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="briefing"
    >
      <View style={styles.briefingHead}>
        <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
          <History size={18} color={colors.foreground} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">While you were away</Text>
          <Text variant="small" muted>
            {[done > 0 && `${plural(done, "task")} done`, failed > 0 && `${failed} failed`]
              .filter(Boolean)
              .join(", ")}{" "}
            since {phoneDayClock(since)}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            animateLayout();
            dismiss();
          }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss the briefing"
          android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
          style={styles.dismiss}
        >
          <X size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
      {[...byBot.entries()].map(([botId, botItems]) => {
        const bot = bots.find((entry) => entry.id === botId);
        const extra = botItems.length - PER_BOT;
        return (
          <View key={botId} style={styles.briefingBot}>
            <BotAvatar
              name={bot?.name ?? "?"}
              color={bot?.color ?? "#888888"}
              emoji={bot?.emoji}
              size="sm"
            />
            <View style={{ flex: 1 }}>
              <View style={styles.briefingName}>
                <Text variant="label" style={{ fontSize: 14 }}>
                  {bot?.name ?? "Former teammate"}
                </Text>
                <Text variant="small" muted>
                  · {plural(botItems.length, "task")}
                </Text>
              </View>
              {botItems.slice(0, PER_BOT).map((item) => {
                const Icon =
                  item.status === "failed"
                    ? AlertCircle
                    : item.trigger in TRIGGER_ICONS
                      ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
                      : null;
                return (
                  <Pressable
                    key={item.runId}
                    onPress={() => router.push(chatHref(item.chatId, item.runId))}
                    accessibilityRole="button"
                    style={styles.briefingItem}
                  >
                    <View style={{ width: 14, paddingTop: 3 }}>
                      {Icon && (
                        <Icon
                          size={13}
                          color={
                            item.status === "failed" ? colors.destructive : colors.mutedForeground
                          }
                        />
                      )}
                    </View>
                    <Text
                      variant="small"
                      numberOfLines={2}
                      style={[
                        { flex: 1, fontSize: 14, lineHeight: 19 },
                        item.status === "failed" && { color: colors.destructive },
                      ]}
                    >
                      {item.automationTitle && (
                        <Text variant="small" style={{ fontWeight: "600", fontSize: 14 }}>
                          {item.automationTitle}:{" "}
                        </Text>
                      )}
                      {plainText(item.preview ?? (item.status === "failed" ? "Failed" : "Done"))}
                    </Text>
                    <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                      {phoneDayClock(item.completedAt)}
                    </Text>
                  </Pressable>
                );
              })}
              {extra > 0 && (
                <Text variant="caption" muted style={{ paddingLeft: space(5.5), paddingTop: 2 }}>
                  and {extra} more
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A teammate's latest conversation with you, for the roster's preview. */
function latestChat(bot: BotSummary, chats: ChatSummary[]): ChatSummary | undefined {
  const direct = chats.filter((chat) => chat.kind === "direct" && chat.botId === bot.id);
  return (
    direct.find((chat) => chat.id === bot.directChatId) ??
    [...direct].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
  );
}

/** One teammate: their face and state, and the last thing said between you. */
function TeammateRow({
  bot,
  chat,
  first,
  onPress,
}: {
  bot: BotSummary;
  chat: ChatSummary | undefined;
  first: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const activity = botActivity(bot);
  const unread = Boolean(chat?.unread);
  const state =
    activity === "waiting"
      ? bot.activeRun?.waitingFor === "takeover"
        ? "Needs you to take over"
        : "Waiting for your OK"
      : activity === "working"
        ? "Working on it…"
        : activity === "queued"
          ? "Up next"
          : null;
  const preview = chat?.preview
    ? `${chat.preview.botId ? "" : "You: "}${chat.preview.text}`
    : `Say hi to ${bot.name}, your ${bot.role}.`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={() => {
        haptics.press();
        router.push(`/teammates/${bot.id}`);
      }}
      accessibilityRole="button"
      accessibilityHint={`Hold to see ${bot.name}'s profile`}
      accessibilityLabel={[
        bot.name,
        bot.isPrimary ? "lead" : null,
        state,
        unread ? "unread" : null,
        preview,
      ]
        .filter(Boolean)
        .join(", ")}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.teammate,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID="teammate"
    >
      <BotAvatar {...bot} size="lg" activity={activity} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.nameRow}>
          <Text
            variant="label"
            numberOfLines={1}
            style={[{ flexShrink: 1, fontSize: 16 }, unread && { fontWeight: "700" }]}
          >
            {bot.name}
          </Text>
          {bot.isPrimary && <Crown size={13} color={colors.mutedForeground} />}
          <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {bot.role}
          </Text>
          {chat && (
            <Text
              variant="caption"
              muted={!unread}
              style={[{ marginLeft: "auto" }, unread && { fontWeight: "600" }]}
            >
              {ago(chat.lastActivityAt)}
            </Text>
          )}
        </View>
        <View style={styles.previewRow}>
          {state ? (
            <Text
              variant="small"
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 14,
                fontWeight: "500",
                color: activity === "waiting" ? colors.attentionInk : colors.working,
              }}
            >
              {state}
            </Text>
          ) : (
            <Text
              variant="small"
              numberOfLines={2}
              muted={!unread}
              style={{ flex: 1, fontSize: 14, lineHeight: 19 }}
            >
              {plainText(preview)}
            </Text>
          )}
          {unread && <View style={[styles.unread, { backgroundColor: colors.foreground }]} />}
        </View>
      </View>
    </Pressable>
  );
}

function Teammates({ bots, chats }: { bots: BotSummary[]; chats: ChatSummary[] }) {
  const newChat = useNewDirectChat();
  const open = (bot: BotSummary) => {
    haptics.tap();
    const chatId = bot.activeRun?.chatId ?? latestChat(bot, chats)?.id ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };
  // Who needs you first, then who's working, then everyone by their latest conversation.
  const rank = { waiting: 0, working: 1, queued: 2, idle: 3 } as const;
  const sorted = [...bots].sort((a, b) => {
    const byState = rank[botActivity(a)] - rank[botActivity(b)];
    if (byState) return byState;
    const at = (bot: BotSummary) => latestChat(bot, chats)?.lastActivityAt ?? "";
    return at(b).localeCompare(at(a));
  });
  return (
    <Section title="Teammates">
      <Card>
        {sorted.map((bot, index) => (
          <TeammateRow
            key={bot.id}
            bot={bot}
            chat={latestChat(bot, chats)}
            first={index === 0}
            onPress={() => open(bot)}
          />
        ))}
      </Card>
    </Section>
  );
}

function ActivityRow({
  item,
  bot,
  first,
}: {
  item: ActivityItem;
  bot?: BotSummary;
  first: boolean;
}) {
  const colors = useColors();
  const active = isRunActive(item.status);
  const Icon =
    item.chatKind === "group"
      ? Users
      : item.trigger in TRIGGER_ICONS
        ? TRIGGER_ICONS[item.trigger as keyof typeof TRIGGER_ICONS]
        : null;
  const where =
    item.chatKind === "group"
      ? item.chatTitle
      : item.trigger === "schedule"
        ? "Scheduled"
        : item.trigger === "watch"
          ? "Page changed"
          : item.trigger === "webhook"
            ? "Webhook"
            : item.trigger === "gmail"
              ? "New mail"
              : item.trigger === "calendar"
                ? "Event coming up"
                : null;
  return (
    <Pressable
      onPress={() => router.push(chatHref(item.chatId, item.runId))}
      accessibilityRole="button"
      android_ripple={{ color: colors.muted }}
      style={[
        styles.activity,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <BotAvatar
        name={bot?.name ?? "?"}
        color={bot?.color ?? "#888888"}
        emoji={bot?.emoji}
        size="sm"
      />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.activityMeta}>
          <Text variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
            {bot?.name ?? "Former teammate"}
          </Text>
          {Icon && <Icon size={12} color={colors.mutedForeground} />}
          {where && (
            <Text variant="small" muted numberOfLines={1} style={{ flexShrink: 1 }}>
              {where}
            </Text>
          )}
          <Text variant="caption" muted style={{ marginLeft: "auto" }}>
            {ago(item.createdAt)}
          </Text>
        </View>
        {active ? (
          <Text
            variant="small"
            style={{
              fontSize: 14,
              color: item.status === "waiting" ? colors.attentionInk : colors.working,
            }}
          >
            {item.status === "waiting" ? "Waiting for you" : "Working on it…"}
          </Text>
        ) : (
          <Text
            variant="small"
            numberOfLines={2}
            style={[
              { fontSize: 14, lineHeight: 19 },
              item.status === "failed" && { color: colors.destructive },
            ]}
          >
            {plainText(item.preview ?? (item.status === "interrupted" ? "Stopped" : "Done"))}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** Home: what needs you, what you missed, and your teammates with where you left off. */
/** How many pages Home shows. */
const PAGES_ON_HOME = 3;

/** The latest pages teammates made, pinned ones first. */
function Pages({ pages, bots }: { pages: PageSummary[]; bots: BotSummary[] }) {
  const colors = useColors();
  const [menuFor, setMenuFor] = useState<PageSummary | null>(null);
  const shown = useMemo(() => sortPages(pages).slice(0, PAGES_ON_HOME), [pages]);
  if (shown.length === 0) return null;
  return (
    <Section
      title="Pages"
      action={
        <Pressable
          onPress={() => router.push("/pages")}
          accessibilityRole="button"
          hitSlop={12}
          style={styles.seeAll}
          testID="all-pages"
        >
          <Text variant="small" muted style={{ fontWeight: "500" }}>
            {pages.length > PAGES_ON_HOME ? `All ${pages.length}` : "All pages"}
          </Text>
          <ChevronRight size={14} color={colors.mutedForeground} />
        </Pressable>
      }
    >
      <Card>
        {shown.map((page, index) => (
          <PageRow
            key={page.id}
            page={page}
            bot={bots.find((bot) => bot.id === page.botId)}
            first={index === 0}
            onLongPress={() => setMenuFor(page)}
          />
        ))}
      </Card>
      <PageMenu page={menuFor} onClose={() => setMenuFor(null)} />
    </Section>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const home = useHome();
  const teammates = useTeammates();
  const chats = useChats();
  const pages = usePages();
  const { awaySince } = usePresence();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([home.refetch(), teammates.refetch(), chats.refetch(), pages.refetch()]);
    setRefreshing(false);
  }, [home, teammates, chats, pages]);
  // Direct chats already show on the roster; this is what happened elsewhere.
  const recent = useMemo(
    () => (home.data?.activity ?? []).filter((item) => item.chatKind !== "direct").slice(0, RECENT),
    [home.data],
  );

  if (home.isLoading || teammates.isLoading) return <Loading />;
  const error = home.error ?? teammates.error;
  if (error && (!home.data || !teammates.data))
    return (
      <LoadError
        error={error}
        onRetry={() => {
          void home.refetch();
          void teammates.refetch();
        }}
      />
    );
  const data = home.data!;
  const bots = teammates.data ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      testID="home"
    >
      <ConnectionNotice />
      <View style={{ gap: space(1) }}>
        <Text variant="title" style={{ fontSize: 30, lineHeight: 36 }}>
          {greeting(data.user.name)}
        </Text>
        <Text muted style={{ fontSize: 16, lineHeight: 22 }}>
          {statusLine(data, bots)}
        </Text>
      </View>
      <NeedsYou home={data} bots={bots} />
      {awaySince && <Briefing items={data.briefing} bots={bots} since={awaySince} />}
      {bots.length === 0 ? (
        <Empty
          icon={<Users size={28} color={colors.mutedForeground} />}
          title="No teammates yet"
          body="Create your first teammate in open-bot on a computer."
        />
      ) : (
        <>
          <Teammates bots={bots} chats={chats.data ?? []} />
          <Pages pages={pages.data ?? []} bots={bots} />
          {recent.length > 0 && (
            <Section
              title="Elsewhere"
              action={
                <Pressable
                  onPress={() => router.navigate("/chats")}
                  accessibilityRole="button"
                  hitSlop={12}
                  style={styles.seeAll}
                >
                  <Text variant="small" muted style={{ fontWeight: "500" }}>
                    All chats
                  </Text>
                  <ChevronRight size={14} color={colors.mutedForeground} />
                </Pressable>
              }
            >
              <Card>
                {recent.map((item, index) => (
                  <ActivityRow
                    key={item.runId}
                    item={item}
                    bot={bots.find((bot) => bot.id === item.botId)}
                    first={index === 0}
                  />
                ))}
              </Card>
            </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(1), gap: space(7), paddingBottom: space(10) },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingLeft: space(3.5),
    paddingRight: space(3),
    paddingVertical: space(3),
    overflow: "hidden",
  },
  calloutAction: {
    borderRadius: radius.full,
    paddingHorizontal: space(3.5),
    minHeight: 36,
    justifyContent: "center",
  },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space(3.5),
  },
  briefing: {
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingTop: space(4),
    paddingBottom: space(3),
    gap: space(4),
  },
  briefingHead: { flexDirection: "row", alignItems: "center", gap: space(3) },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  dismiss: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginRight: -space(2),
  },
  briefingBot: { flexDirection: "row", gap: space(3) },
  briefingName: { flexDirection: "row", alignItems: "center", gap: space(1.5), height: 28 },
  briefingItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(2),
    paddingVertical: space(1.5),
    minHeight: 32,
  },
  teammate: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
    minHeight: 80,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  previewRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  unread: { width: 9, height: 9, borderRadius: 5 },
  activity: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  activityMeta: { flexDirection: "row", alignItems: "center", gap: space(1.5), minHeight: 28 },
  seeAll: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 32 },
});
