import type {
  ActivityItem,
  ApprovalView,
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
  CloudOff,
  Eye,
  Hand,
  History,
  Mail,
  Monitor,
  ShieldAlert,
  Sparkles,
  Users,
  Webhook,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
} from "react-native";
import {
  activityColor,
  activityText,
  BotAvatar,
  botActivity,
  LeadBadge,
  needsYouText,
  StatusLine,
  type BotActivity,
} from "@/components/bot-avatar";
import { ComputerOfflineNotice, ConnectionNotice } from "@/components/connection-notice";
import { ApprovalRow } from "@/components/approval-row";
import { Separator } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { usePresence } from "@/lib/presence";
import { PageMenu, PageRow } from "@/components/page-row";
import { sortPages } from "@/lib/pages";
import {
  useApprovals,
  useChats,
  useComputerOffline,
  useHome,
  useNewDirectChat,
  usePages,
  useTeammates,
} from "@/lib/queries";
import { takePasswordResetRequest } from "@/lib/password";
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

/**
 * The line under the greeting: what's going on, in a few words. While the computer is offline
 * nobody is working, so it never says they are (the notice under it says why).
 */
function statusLine(
  home: Home,
  bots: BotSummary[],
  computerOffline = false,
  approvals = home.pendingApprovals,
): string {
  // What you can act on in the app, the same things the section under it lists one by one.
  const needs = approvals + home.takeoverRequests.length;
  if (needs > 0) return `${plural(needs, "thing")} ${needs === 1 ? "needs" : "need"} you.`;
  if (computerOffline) return "Nothing needs you. Work picks up when the computer is back.";
  const working = bots.filter((bot) => botActivity(bot) === "working");
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
  const dark = useColorScheme() === "dark";
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
          borderColor: mix(colors.attention, colors.surface, dark ? 0.28 : 0.42),
          backgroundColor: mix(colors.attention, colors.surface, dark ? 0.06 : 0.08),
        },
      ]}
      testID={testID}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>{children}</View>
      {/* The card already says "needs you"; the action itself stays ink, like every button. */}
      <View style={[styles.calloutAction, { backgroundColor: colors.primary }]}>
        <Text variant="small" style={{ color: colors.primaryForeground, fontWeight: "600" }}>
          {action}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * What needs you, each thing on its own: every approval as a row (strongest, as you can decide it
 * right here), then takeovers, then suggestions you review on the computer, which aren't counted.
 */
function NeedsYou({
  home,
  approvals,
  bots,
  computerOffline,
}: {
  home: Home;
  /** Pending approvals, or null until they've loaded (Home's count stands in until then). */
  approvals: ApprovalView[] | null;
  bots: BotSummary[];
  computerOffline: boolean;
}) {
  const colors = useColors();
  const proposals = home.proposals.flatMap((proposal) => {
    const bot = bots.find((entry) => entry.id === proposal.botId);
    return bot ? [{ ...proposal, bot }] : [];
  });
  const approvalCount = approvals?.length ?? home.pendingApprovals;
  const needs = approvalCount + home.takeoverRequests.length;
  if (needs === 0 && proposals.length === 0) return null;
  const pendingFill = mix(colors.attention, colors.surface, 0.07);
  return (
    <Section title={needs > 0 ? "Needs you" : "Suggestions"}>
      <View style={{ gap: space(3) }}>
        {approvals && approvals.length > 0 ? (
          <View
            style={[
              styles.approvals,
              {
                backgroundColor: pendingFill,
                borderColor: mix(colors.attention, colors.surface, 0.45),
              },
            ]}
            testID="pending-approvals"
          >
            {approvals.map((approval, index) => (
              <View key={approval.id}>
                {index > 0 && <Separator />}
                <ApprovalRow
                  approval={approval}
                  bot={bots.find((bot) => bot.id === approval.botId)}
                  meta={ago(approval.createdAt)}
                  behind={pendingFill}
                  short
                />
              </View>
            ))}
          </View>
        ) : approvalCount > 0 ? (
          // The list hasn't loaded: the count, with a way to the full list.
          <Callout
            leading={
              <View
                style={[
                  styles.mark,
                  { backgroundColor: mix(colors.attention, colors.surface, 0.22) },
                ]}
              >
                <ShieldAlert size={20} color={colors.attentionInk} />
              </View>
            }
            onPress={() => router.navigate("/approvals")}
            action="Review"
            testID="pending-approvals"
          >
            <Text variant="label">
              {approvalCount === 1
                ? "1 action needs your approval"
                : `${approvalCount} actions need your approval`}
            </Text>
          </Callout>
        ) : null}
        {home.takeoverRequests.map((request) => {
          const bot = bots.find((entry) => entry.id === request.botId);
          const open = () => router.push(screenHref(request.screenId, request.id));
          // The screen can't be driven while the computer is away: a lighter card, after what
          // you can decide now, that only says when you can.
          return computerOffline ? (
            <TakeoverLater key={request.id} request={request} bot={bot} onOpen={open} />
          ) : (
            <Callout
              key={request.id}
              leading={
                bot ? (
                  <BotAvatar {...bot} size="md" />
                ) : (
                  <Hand size={20} color={colors.attentionInk} />
                )
              }
              onPress={open}
              action="Open"
              testID="takeover-request"
            >
              <Text variant="label">
                {request.botName} {needsYouText("takeover").toLowerCase()}
              </Text>
              {request.reason ? (
                <Text variant="small" muted numberOfLines={2} style={styles.calloutBody}>
                  {request.reason}
                </Text>
              ) : null}
            </Callout>
          );
        })}
        {proposals.map((proposal) => (
          <View
            key={proposal.id}
            style={[
              styles.suggestion,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
            accessible
            accessibilityLabel={`Suggestion: ${proposal.bot.name} suggests new instructions. Review them in open-bot on your computer.`}
            testID="proposal"
          >
            <View style={[styles.suggestionIcon, { backgroundColor: colors.subtle }]}>
              <Sparkles size={16} color={colors.foreground} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text variant="label" numberOfLines={1} style={{ fontSize: 15 }}>
                {proposal.bot.name} suggests new instructions
              </Text>
              <View style={styles.noteTag}>
                <Monitor size={12} color={colors.mutedForeground} />
                <Text variant="caption" muted numberOfLines={1}>
                  Suggestion · review it on your computer
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>
    </Section>
  );
}

/**
 * A takeover while the computer is offline: who needs you and why on one line each, when you
 * can act, and a small way to read the request.
 */
function TakeoverLater({
  request,
  bot,
  onOpen,
}: {
  request: Home["takeoverRequests"][number];
  bot: BotSummary | undefined;
  onOpen: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={[styles.later, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="takeover-request"
    >
      <View style={styles.laterHead}>
        {bot ? (
          <BotAvatar {...bot} size="md" activity="waiting" />
        ) : (
          <Hand size={20} color={colors.attentionInk} />
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>
            {request.botName} {needsYouText("takeover").toLowerCase()}
          </Text>
          {request.reason ? (
            <Text variant="small" muted numberOfLines={1}>
              {request.reason}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.laterFoot}>
        <View style={[styles.noteTag, { flex: 1 }]}>
          <CloudOff size={13} color={colors.mutedForeground} />
          <Text variant="caption" muted numberOfLines={1} testID="takeover-later">
            When the computer is back
          </Text>
        </View>
        <Pressable
          onPress={() => {
            haptics.tap();
            onOpen();
          }}
          accessibilityRole="button"
          android_ripple={{ color: colors.muted }}
          style={[styles.small, { borderColor: colors.input, backgroundColor: colors.surface }]}
        >
          <Text variant="small" style={{ fontWeight: "600" }}>
            View request
          </Text>
        </Pressable>
      </View>
    </View>
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

/**
 * One teammate: their face, name and job, and their status from the fixed list (the same words as
 * the web and the Computer tab). When you last talked is on the right.
 */
function TeammateRow({
  bot,
  chat,
  first,
  computerOffline,
  onPress,
}: {
  bot: BotSummary;
  chat: ChatSummary | undefined;
  first: boolean;
  computerOffline: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const activity = botActivity(bot, computerOffline);
  const unread = Boolean(chat?.unread);
  const state = activityText(activity, bot.activeRun?.waitingFor);
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
        bot.role,
        unread ? "unread" : null,
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
          {bot.isPrimary && <LeadBadge />}
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
          <View style={{ flex: 1 }}>
            <StatusLine activity={activity} waitingFor={bot.activeRun?.waitingFor} />
          </View>
          {unread && <View style={[styles.unread, { backgroundColor: colors.foreground }]} />}
        </View>
      </View>
    </Pressable>
  );
}

function Teammates({
  bots,
  chats,
  computerOffline,
}: {
  bots: BotSummary[];
  chats: ChatSummary[];
  computerOffline: boolean;
}) {
  const newChat = useNewDirectChat();
  const open = (bot: BotSummary) => {
    haptics.tap();
    const chatId = bot.activeRun?.chatId ?? latestChat(bot, chats)?.id ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };
  // Who needs you first, then who's working, then everyone by their latest conversation.
  const rank = { waiting: 0, working: 1, paused: 1, queued: 2, idle: 3 } as const;
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
            computerOffline={computerOffline}
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
  computerOffline,
}: {
  item: ActivityItem;
  bot?: BotSummary;
  first: boolean;
  computerOffline: boolean;
}) {
  const colors = useColors();
  const active = isRunActive(item.status);
  // A run that is still going reads like its teammate does: needs you, working, or paused.
  const activity: BotActivity =
    item.status === "waiting" ? "waiting" : computerOffline ? "paused" : "working";
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
          <Text variant="small" style={{ fontSize: 14, color: activityColor(activity, colors) }}>
            {activityText(
              activity,
              bot?.activeRun?.id === item.runId ? bot.activeRun.waitingFor : null,
            )}
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
          onPress={() => router.navigate("/pages")}
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
            onMenu={() => setMenuFor(page)}
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
  const computerOffline = useComputerOffline();
  const approvals = useApprovals();
  const pending = useMemo(
    () => approvals.data?.filter((approval) => approval.status === "pending") ?? null,
    [approvals.data],
  );
  const { awaySince } = usePresence();
  // Signed in with a passkey from "Forgot password?": straight on to setting a new one.
  useEffect(() => {
    if (takePasswordResetRequest()) router.push("/settings?password=new");
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      home.refetch(),
      teammates.refetch(),
      chats.refetch(),
      pages.refetch(),
      approvals.refetch(),
    ]);
    setRefreshing(false);
  }, [home, teammates, chats, pages, approvals]);
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
      <View style={styles.greeting}>
        <View style={{ gap: space(1) }}>
          <Text variant="title" style={{ fontSize: 30, lineHeight: 36 }}>
            {greeting(data.user.name)}
          </Text>
          <Text muted style={{ fontSize: 16, lineHeight: 22 }} testID="home-status">
            {statusLine(data, bots, computerOffline, pending?.length)}
          </Text>
        </View>
        <ComputerOfflineNotice />
      </View>
      <NeedsYou home={data} approvals={pending} bots={bots} computerOffline={computerOffline} />
      {awaySince && <Briefing items={data.briefing} bots={bots} since={awaySince} />}
      {bots.length === 0 ? (
        <Empty
          icon={<Users size={28} color={colors.mutedForeground} />}
          title="No teammates yet"
          body="Create your first teammate in open-bot on a computer."
        />
      ) : (
        <>
          <Teammates bots={bots} chats={chats.data ?? []} computerOffline={computerOffline} />
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
                    computerOffline={computerOffline}
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
  content: { padding: space(4), paddingTop: space(1), gap: space(7), paddingBottom: space(8) },
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
  calloutBody: { fontSize: 14, lineHeight: 19 },
  approvals: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  later: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  laterHead: { flexDirection: "row", alignItems: "center", gap: space(3) },
  // Under the words, past the avatar.
  laterFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingLeft: 36 + space(3),
  },
  small: {
    minHeight: 32,
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
    minHeight: 56,
  },
  suggestionIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  // The greeting sits a little closer to what follows than sections do to each other.
  greeting: { gap: space(4), marginBottom: -space(1) },
  noteTag: { flexDirection: "row", alignItems: "center", gap: space(1) },
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
    paddingVertical: space(3),
    minHeight: 72,
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
