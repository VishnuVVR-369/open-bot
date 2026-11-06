import type { ChatSummary } from "@open-bot/api";
import { AUTONOMY_OPTIONS, plainText } from "@open-bot/shared";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  CalendarClock,
  ChevronRight,
  Crown,
  Hand,
  Mail,
  MessageCircle,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  SquarePen,
  Users,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { ApprovalTitle } from "@/components/approval-parts";
import { BotAvatar, botActivity, GroupAvatar, needsYouText } from "@/components/bot-avatar";
import { Card, Section } from "@/components/section";
import { Empty, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { chatSubtitle, chatTitle } from "@/lib/chats";
import { haptics } from "@/lib/haptics";
import {
  useApprovalRules,
  useApprovals,
  useChats,
  useHome,
  useNewDirectChat,
  useTeammates,
} from "@/lib/queries";
import { screenHref } from "@/lib/screens";
import { ago, lastActive } from "@/lib/time";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** A big round action under the teammate's name. */
function Action({
  icon,
  label,
  onPress,
  primary,
  testID,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  primary?: boolean;
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
      accessibilityLabel={label}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.action,
        primary
          ? { backgroundColor: colors.primary }
          : { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
      ]}
      testID={testID}
    >
      {icon}
      <Text
        variant="small"
        style={{ fontWeight: "600", color: primary ? colors.primaryForeground : colors.foreground }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** What the teammate is waiting on you for, as one tappable card that opens it. */
function PendingBanner({
  kind,
  title,
  onPress,
}: {
  kind: "approval" | "takeover";
  title: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  const Icon = kind === "takeover" ? Hand : ShieldAlert;
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${needsYouText(kind)}: ${title}`}
      accessibilityHint={kind === "takeover" ? "Opens the screen" : "Opens the request"}
      android_ripple={{ color: mix(colors.attention, colors.surface, 0.18) }}
      style={[
        styles.banner,
        {
          borderColor: mix(colors.attention, colors.surface, dark ? 0.28 : 0.42),
          backgroundColor: mix(colors.attention, colors.surface, dark ? 0.06 : 0.08),
        },
      ]}
      testID="profile-pending"
    >
      <View style={[styles.icon, { backgroundColor: mix(colors.attention, colors.surface, 0.22) }]}>
        <Icon size={18} color={colors.attentionInk} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="small" style={{ color: colors.attentionInk, fontWeight: "600" }}>
          {needsYouText(kind)}
        </Text>
        <ApprovalTitle title={title} numberOfLines={2} />
      </View>
      <View style={styles.review}>
        <Text variant="small" style={{ fontWeight: "600" }}>
          {kind === "takeover" ? "Open" : "Review"}
        </Text>
        <ChevronRight size={16} color={colors.foreground} />
      </View>
    </Pressable>
  );
}

function Row({
  leading,
  title,
  subtitle,
  aside,
  onPress,
  first,
}: {
  leading: ReactNode;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
  onPress: () => void;
  first: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="small" muted numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {aside ?? <ChevronRight size={18} color={colors.mutedForeground} />}
    </Pressable>
  );
}

/**
 * A teammate: who they are and what they're doing, ways to reach them and their screen, and
 * every conversation you have with them.
 */
export default function TeammateScreen() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const teammates = useTeammates();
  const chats = useChats();
  const { data: rules = [] } = useApprovalRules();
  const { data: approvals = [] } = useApprovals();
  const { data: home } = useHome();
  const newChat = useNewDirectChat();
  const bot = teammates.data?.find((candidate) => candidate.id === botId);

  if (teammates.isLoading) return <Loading />;
  if (!bot)
    return (
      <Empty
        icon={<Users size={28} color={colors.mutedForeground} />}
        title="This teammate isn't here"
        body="They may have been removed on the web."
      />
    );

  const activity = botActivity(bot);
  const all = chats.data ?? [];
  const theirs = all
    .filter(
      (chat) => chat.botId === bot.id || (chat.kind === "group" && chat.memberIds.includes(bot.id)),
    )
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const latest = theirs.find((chat) => chat.kind === "direct");
  const autonomy = AUTONOMY_OPTIONS.find((option) => option.value === bot.autonomy);
  const ruleCount = rules.filter((rule) => rule.botId === bot.id).length;
  const bots = teammates.data ?? [];
  const approval = approvals.find((entry) => entry.status === "pending" && entry.botId === bot.id);
  const takeover = home?.takeoverRequests.find((request) => request.botId === bot.id);
  // A conversation to go back to, or a first one to start.
  const continuing = Boolean(bot.activeRun?.chatId ?? latest?.id ?? bot.directChatId);

  const message = () => {
    const chatId = bot.activeRun?.chatId ?? latest?.id ?? bot.directChatId;
    if (chatId) router.push(`/chats/${chatId}`);
    else newChat.mutate(bot.id);
  };
  const leadingFor = (chat: ChatSummary) => {
    if (chat.kind === "group")
      return (
        <GroupAvatar
          members={chat.memberIds.flatMap((id) => bots.filter((entry) => entry.id === id))}
          size="md"
          ring={colors.surface}
        />
      );
    const Icon =
      chat.kind === "scheduled" ? CalendarClock : chat.kind === "inbox" ? Mail : MessageCircle;
    return (
      <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
        <Icon size={18} color={colors.foreground} />
      </View>
    );
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
      testID="teammate-profile"
    >
      <Stack.Screen options={{ title: "" }} />
      <View style={styles.hero}>
        <BotAvatar {...bot} size="xl" activity={activity} />
        <View style={{ alignItems: "center", gap: space(1) }}>
          <View style={styles.nameRow}>
            <Text variant="title" style={{ fontSize: 28, lineHeight: 34 }}>
              {bot.name}
            </Text>
            {bot.isPrimary && <Crown size={18} color={colors.mutedForeground} />}
          </View>
          <Text muted style={{ fontSize: 16, textAlign: "center" }}>
            {bot.isPrimary ? `Lead · ${bot.role}` : bot.role}
          </Text>
          {activity === "idle" && bot.lastActiveAt ? (
            <Text variant="small" muted testID="last-active">
              {lastActive(bot.lastActiveAt)}
            </Text>
          ) : null}
          {(activity === "working" || activity === "queued") && (
            <Text
              variant="small"
              style={{
                fontWeight: "500",
                color: activity === "working" ? colors.working : colors.mutedForeground,
              }}
            >
              {activity === "working" ? "Working on it…" : "Up next"}
            </Text>
          )}
        </View>
        {takeover ? (
          <PendingBanner
            kind="takeover"
            title={takeover.reason ?? `${bot.name} needs you on the screen`}
            onPress={() => router.push(screenHref(takeover.screenId, takeover.id))}
          />
        ) : approval ? (
          <PendingBanner
            kind="approval"
            title={approval.title}
            onPress={() => router.push(`/approvals/${approval.id}`)}
          />
        ) : null}
        <View style={styles.actions}>
          <Action
            icon={<MessageCircle size={20} color={colors.primaryForeground} />}
            label={continuing ? "Continue chat" : "Message"}
            onPress={message}
            primary
            testID="profile-message"
          />
          <Action
            icon={<SquarePen size={20} color={colors.foreground} />}
            label="New chat"
            onPress={() => newChat.mutate(bot.id)}
          />
          <Action
            icon={<Monitor size={20} color={colors.foreground} />}
            label="Screen"
            onPress={() => router.push(screenHref(bot.id))}
            testID="profile-screen"
          />
        </View>
      </View>

      <Section title="How they work">
        <Card>
          <View style={styles.about}>
            <Text variant="label">{autonomy?.label ?? bot.autonomy}</Text>
            {autonomy && (
              <Text variant="small" muted>
                {autonomy.description}
              </Text>
            )}
          </View>
          <Row
            first={false}
            leading={
              <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
                <ShieldCheck size={18} color={colors.done} />
              </View>
            }
            title="Always allowed"
            subtitle={
              ruleCount === 0
                ? "Nothing yet. Use Always allow on an approval."
                : `${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}: ${bot.name} doesn't ask about these`
            }
            onPress={() => router.push("/approval-rules")}
          />
        </Card>
      </Section>

      {theirs.length > 0 && (
        <Section title="Conversations">
          <Card>
            {theirs.map((chat, index) => (
              <Row
                key={chat.id}
                first={index === 0}
                leading={leadingFor(chat)}
                title={chat.kind === "group" ? chat.title : chatTitle(chat, bot)}
                subtitle={plainText(chatSubtitle(chat, bot, bots))}
                aside={
                  <Text variant="caption" muted>
                    {ago(chat.lastActivityAt)}
                  </Text>
                }
                onPress={() => router.push(`/chats/${chat.id}`)}
              />
            ))}
          </Card>
        </Section>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(7) },
  hero: { alignItems: "center", gap: space(4), paddingTop: space(2) },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  banner: {
    alignSelf: "stretch",
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
  review: { flexDirection: "row", alignItems: "center", gap: 2 },
  actions: { flexDirection: "row", gap: space(2.5), alignSelf: "stretch" },
  action: {
    flex: 1,
    minHeight: 64,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    gap: space(1),
    overflow: "hidden",
  },
  about: { padding: space(4), gap: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
