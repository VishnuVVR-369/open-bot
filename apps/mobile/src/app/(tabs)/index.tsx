import type { ActivityItem, BotSummary, BriefingItem, Home } from "@open-bot/api";
import { isRunActive, plainText } from "@open-bot/shared";
import { router, type Href } from "expo-router";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  ChevronRight,
  Eye,
  Hand,
  History,
  ShieldAlert,
  Sparkles,
  Users,
  Webhook,
  X,
} from "lucide-react-native";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { BotAvatar, botActivity, botStatusText } from "@/components/bot-avatar";
import { ConnectionNotice } from "@/components/connection-notice";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { usePresence } from "@/lib/presence";
import { useHome, useNewDirectChat, useTeammates } from "@/lib/queries";
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

/** A tappable row inside a card. */
function Row({
  onPress,
  children,
  testID,
  divider = true,
}: {
  onPress?: () => void;
  children: ReactNode;
  testID?: string;
  divider?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/** Something that needs you, in a tinted card of its own. */
function Callout({
  icon,
  tint,
  onPress,
  children,
  testID,
}: {
  icon: ReactNode;
  tint: string;
  onPress?: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      android_ripple={{ color: mix(tint, colors.surface, 0.12) }}
      style={[
        styles.callout,
        {
          borderColor: mix(tint, colors.surface, 0.4),
          backgroundColor: mix(tint, colors.background, 0.07),
        },
      ]}
      testID={testID}
    >
      {icon}
      <View style={{ flex: 1 }}>{children}</View>
      {onPress && <ArrowRight size={16} color={colors.mutedForeground} />}
    </Pressable>
  );
}

function NeedsYou({ home, bots }: { home: Home; bots: BotSummary[] }) {
  const colors = useColors();
  const proposals = home.proposals.flatMap((proposal) => {
    const bot = bots.find((entry) => entry.id === proposal.botId);
    return bot ? [{ ...proposal, bot }] : [];
  });
  if (home.pendingApprovals === 0 && home.takeoverRequests.length === 0 && proposals.length === 0)
    return null;
  return (
    <Section title="Needs you">
      <View style={{ gap: space(2) }}>
        {home.takeoverRequests.map((request) => (
          <Callout
            key={request.id}
            icon={<Hand size={16} color={colors.manualInk} />}
            tint={colors.manual}
            onPress={() => router.push(screenHref(request.screenId, request.id))}
            testID="takeover-request"
          >
            <Text variant="small" style={{ fontSize: 14 }}>
              <Text variant="small" style={{ fontSize: 14, fontWeight: "500" }}>
                {request.botName} needs you to take over:
              </Text>{" "}
              <Text variant="small" muted style={{ fontSize: 14 }}>
                {request.reason}
              </Text>
            </Text>
          </Callout>
        ))}
        {home.pendingApprovals > 0 && (
          <Callout
            icon={<ShieldAlert size={16} color={colors.waiting} />}
            tint={colors.waiting}
            onPress={() => router.navigate("/approvals")}
            testID="pending-approvals"
          >
            <Text variant="label" style={{ fontSize: 14 }}>
              {home.pendingApprovals === 1
                ? "1 action is waiting for your approval"
                : `${home.pendingApprovals} actions are waiting for your approval`}
            </Text>
          </Callout>
        )}
        {proposals.map((proposal) => (
          <Callout
            key={proposal.id}
            icon={<Sparkles size={16} color={colors.waiting} />}
            tint={colors.border}
          >
            <Text variant="label" style={{ fontSize: 14 }}>
              {proposal.bot.name} suggests new instructions
            </Text>
            <Text variant="caption" muted>
              Review them in open-bot on a computer.
            </Text>
          </Callout>
        ))}
      </View>
    </Section>
  );
}

const TRIGGER_ICONS = { schedule: CalendarClock, watch: Eye, webhook: Webhook } as const;

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
          <History size={16} color={colors.mutedForeground} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" style={{ fontSize: 14 }}>
            While you were away
          </Text>
          <Text variant="small" muted>
            {[done > 0 && `${plural(done, "task")} done`, failed > 0 && `${failed} failed`]
              .filter(Boolean)
              .join(", ")}{" "}
            since {phoneDayClock(since)}
          </Text>
        </View>
        <Pressable
          onPress={dismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss the briefing"
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
                <Text variant="small" style={{ fontWeight: "500", fontSize: 14 }}>
                  {bot?.name ?? "Former teammate"}
                </Text>
                <Text variant="small" muted style={{ fontSize: 14 }}>
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
                    style={styles.briefingItem}
                    hitSlop={4}
                  >
                    <View style={{ width: 14, paddingTop: 2 }}>
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
                      numberOfLines={1}
                      style={[
                        { flex: 1, fontSize: 13.5 },
                        item.status === "failed" && { color: colors.destructive },
                      ]}
                    >
                      {item.automationTitle && (
                        <Text variant="small" style={{ fontWeight: "500", fontSize: 13.5 }}>
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
                <Text variant="caption" muted style={{ paddingLeft: space(5), paddingTop: 2 }}>
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

function Teammates({ bots }: { bots: BotSummary[] }) {
  const colors = useColors();
  const newChat = useNewDirectChat();
  const open = (bot: BotSummary) => {
    const chatId = bot.activeRun?.chatId ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };
  return (
    <Section title="Teammates">
      <Card>
        {bots.map((bot, index) => {
          const activity = botActivity(bot);
          return (
            <Row key={bot.id} onPress={() => open(bot)} divider={index > 0} testID="teammate">
              <BotAvatar
                name={bot.name}
                color={bot.color}
                emoji={bot.emoji}
                size="md"
                activity={activity}
              />
              <View style={{ flex: 1, gap: 1 }}>
                <View style={styles.nameRow}>
                  <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {bot.name}
                  </Text>
                  {bot.isPrimary && (
                    <View style={[styles.lead, { backgroundColor: colors.subtle }]}>
                      <Text variant="caption" muted style={{ fontSize: 11, lineHeight: 14 }}>
                        lead
                      </Text>
                    </View>
                  )}
                </View>
                <Text
                  variant="small"
                  numberOfLines={1}
                  muted={activity !== "waiting" && activity !== "working"}
                  style={activity === "waiting" ? { color: colors.waiting } : undefined}
                >
                  {botStatusText(bot)}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.mutedForeground} />
            </Row>
          );
        })}
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
  return (
    <Row onPress={() => router.push(chatHref(item.chatId, item.runId))} divider={!first}>
      <View style={{ alignSelf: "flex-start", paddingTop: 2 }}>
        <BotAvatar
          name={bot?.name ?? "?"}
          color={bot?.color ?? "#888888"}
          emoji={bot?.emoji}
          size="sm"
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.activityMeta}>
          <Text variant="caption" style={{ fontWeight: "500", fontSize: 13 }} numberOfLines={1}>
            {bot?.name ?? "Former teammate"}
          </Text>
          {item.chatKind === "group" && (
            <>
              <Users size={11} color={colors.mutedForeground} />
              <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
                {item.chatTitle}
              </Text>
            </>
          )}
          {item.trigger in TRIGGER_ICONS && (
            <Text variant="caption" muted>
              {item.trigger === "schedule"
                ? "scheduled"
                : item.trigger === "watch"
                  ? "page changed"
                  : "webhook"}
            </Text>
          )}
          <Text variant="caption" muted>
            · {ago(item.createdAt)}
          </Text>
        </View>
        {active ? (
          <View style={styles.activeLine}>
            <View
              style={[
                styles.dot,
                { backgroundColor: item.status === "waiting" ? colors.waiting : colors.live },
              ]}
            />
            <Text variant="small" muted style={{ fontSize: 14 }}>
              {item.status === "waiting" ? "Waiting for you" : "Working on it"}
            </Text>
          </View>
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
    </Row>
  );
}

/** Home: what needs you, what you missed, your teammates and what they did lately. */
export default function HomeScreen() {
  const colors = useColors();
  const home = useHome();
  const teammates = useTeammates();
  const { awaySince } = usePresence();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([home.refetch(), teammates.refetch()]);
    setRefreshing(false);
  }, [home, teammates]);

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
  const working = bots.filter((bot) => bot.activeRun && bot.activeRun.status !== "queued").length;

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
        <Text variant="title" style={{ fontSize: 26, lineHeight: 32 }}>
          {greeting(data.user.name)}
        </Text>
        <Text muted>
          {working > 0
            ? `${plural(working, "teammate")} ${working === 1 ? "is" : "are"} working right now.`
            : "Your teammates are ready when you are."}
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
          <Teammates bots={bots} />
          <Section title="Recent activity">
            {data.activity.length === 0 ? (
              <View style={[styles.nothing, { borderColor: colors.border }]}>
                <Text variant="small" muted style={{ textAlign: "center" }}>
                  Nothing yet. Message a teammate to get them working.
                </Text>
              </View>
            ) : (
              <Card>
                {data.activity.map((item, index) => (
                  <ActivityRow
                    key={item.runId}
                    item={item}
                    bot={bots.find((bot) => bot.id === item.botId)}
                    first={index === 0}
                  />
                ))}
              </Card>
            )}
          </Section>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(5), gap: space(7), paddingBottom: space(10) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(3.5),
    paddingVertical: space(3),
    minHeight: 60,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    overflow: "hidden",
  },
  briefing: {
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingTop: space(3.5),
    paddingBottom: space(3),
    gap: space(3.5),
  },
  briefingHead: { flexDirection: "row", alignItems: "flex-start", gap: space(3) },
  mark: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dismiss: { width: 28, height: 28, alignItems: "center", justifyContent: "center", marginTop: -2 },
  briefingBot: { flexDirection: "row", gap: space(3) },
  briefingName: { flexDirection: "row", alignItems: "center", gap: space(1.5), height: 28 },
  briefingItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(2),
    paddingVertical: 3,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  lead: { borderRadius: radius.full, paddingHorizontal: space(1.5), paddingVertical: 1 },
  activityMeta: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  activeLine: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  dot: { width: 6, height: 6, borderRadius: 3 },
  nothing: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(6),
  },
});
