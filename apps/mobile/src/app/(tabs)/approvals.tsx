import type { ApprovalView, BotSummary } from "@open-bot/api";
import { router } from "expo-router";
import { Check, ChevronRight, ShieldCheck, WifiOff } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { ApprovalAvatar, ApprovalStatusChip, ApprovalTitle } from "@/components/approval-parts";
import { botActivity } from "@/components/bot-avatar";
import { ConnectionNotice } from "@/components/connection-notice";
import { ListRow, Separator } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { shortenPaths } from "@/lib/approval-text";
import { groupByDay, recently, type DayGroup } from "@/lib/day-groups";
import { useOnline } from "@/lib/network";
import { phoneClock, phoneDayClock } from "@/lib/phone-clock";
import { useApprovalRules, useApprovals, useTeammates } from "@/lib/queries";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** When a decision was made; the section above already says which day. */
function decidedWhen(iso: string, group: DayGroup): string {
  if (group === "Today" || group === "Yesterday") return phoneClock(iso);
  if (group === "Earlier this week") return phoneDayClock(iso);
  return ago(iso);
}

function ApprovalRow({
  approval,
  bot,
  meta,
  behind,
}: {
  approval: ApprovalView;
  bot: BotSummary | undefined;
  meta: string;
  /** The card's color, which the avatar's badge cuts into. */
  behind: string;
}) {
  const colors = useColors();
  const pending = approval.status === "pending";
  return (
    <Pressable
      testID="approval"
      onPress={() => router.push(`/approvals/${approval.id}`)}
      android_ripple={{ color: colors.muted }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
      accessibilityRole="button"
      accessibilityHint={pending ? "Opens the request to approve or deny it" : undefined}
    >
      <ApprovalAvatar
        bot={bot}
        kind={approval.kind}
        pending={pending}
        activity={pending && bot ? botActivity(bot) : "idle"}
        behind={behind}
      />
      <View style={styles.text}>
        <ApprovalTitle title={shortenPaths(approval.title)} numberOfLines={2} />
        <Text variant="small" muted numberOfLines={1}>
          {bot?.name ?? "Former teammate"} · {meta}
        </Text>
      </View>
      {pending ? (
        <ChevronRight size={18} color={colors.attentionInk} />
      ) : (
        <ApprovalStatusChip status={approval.status} />
      )}
    </Pressable>
  );
}

/** Nothing waiting: say so plainly, so an empty list reads as done and not as broken. */
function CaughtUp() {
  const colors = useColors();
  return (
    <View
      style={[styles.caughtUp, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessible
      testID="caught-up"
    >
      <View style={[styles.check, { backgroundColor: mix(colors.done, colors.surface, 0.14) }]}>
        <Check size={22} color={colors.done} strokeWidth={2.5} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading">You&apos;re all caught up</Text>
        <Text variant="small" muted>
          Nothing needs your OK. New requests show up here and on your lock screen.
        </Text>
      </View>
    </View>
  );
}

/** What your teammates asked to do: what needs you first, then what you decided, by day. */
export default function Approvals() {
  const colors = useColors();
  const approvals = useApprovals();
  const { data: bots = [] } = useTeammates();
  const { data: rules = [] } = useApprovalRules();
  const online = useOnline();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await approvals.refetch();
    setRefreshing(false);
  }, [approvals]);
  const { pending, history } = useMemo(() => {
    const all = approvals.data ?? [];
    const decidedAt = (approval: ApprovalView) => approval.decidedAt ?? approval.createdAt;
    return {
      pending: all.filter((approval) => approval.status === "pending"),
      history: groupByDay(
        all
          .filter((approval) => approval.status !== "pending")
          .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a))),
        decidedAt,
        { week: true },
      ),
    };
  }, [approvals.data]);
  const botFor = (approval: ApprovalView) =>
    bots.find((candidate) => candidate.id === approval.botId);

  if (approvals.isLoading) return <Loading />;
  if (approvals.error && !approvals.data)
    return <LoadError error={approvals.error} onRetry={() => void approvals.refetch()} />;
  const pendingFill = mix(colors.attention, colors.surface, 0.07);
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
    >
      <ConnectionNotice />
      {pending.length > 0 ? (
        <View style={{ gap: space(2.5) }}>
          <View style={styles.needsHead}>
            <View style={[styles.dot, { backgroundColor: colors.attention }]} />
            <Text
              variant="caption"
              style={[styles.overline, { color: colors.attentionInk }]}
              accessibilityRole="header"
            >
              NEEDS YOU · {pending.length}
            </Text>
          </View>
          {!online && (
            <View style={[styles.offline, { backgroundColor: colors.subtle }]}>
              <WifiOff size={14} color={colors.mutedForeground} />
              <Text variant="small" muted>
                You&apos;re offline. Decide when you&apos;re back online.
              </Text>
            </View>
          )}
          <View
            style={[
              styles.card,
              {
                backgroundColor: pendingFill,
                borderColor: mix(colors.attention, colors.surface, 0.45),
              },
            ]}
          >
            {pending.map((approval, index) => (
              <View key={approval.id}>
                {index > 0 && <Separator />}
                <ApprovalRow
                  approval={approval}
                  bot={botFor(approval)}
                  meta={recently(approval.createdAt) ?? ago(approval.createdAt)}
                  behind={pendingFill}
                />
              </View>
            ))}
          </View>
        </View>
      ) : (
        <CaughtUp />
      )}

      <Card>
        <ListRow
          onPress={() => router.push("/approval-rules")}
          leading={
            <View
              style={[styles.tile, { backgroundColor: mix(colors.done, colors.surface, 0.12) }]}
            >
              <ShieldCheck size={22} color={colors.done} />
            </View>
          }
          title="Always allowed"
          subtitle={
            rules.length > 0
              ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"} · teammates don't ask about these`
              : "Nothing yet · teammates ask first"
          }
          aside={<ChevronRight size={18} color={colors.mutedForeground} />}
          testID="approval-rules"
        />
      </Card>

      {history.map((group) => (
        <Section key={group.title} title={group.title}>
          <Card>
            {group.data.map((approval, index) => (
              <View key={approval.id}>
                {index > 0 && <Separator />}
                <ApprovalRow
                  approval={approval}
                  bot={botFor(approval)}
                  meta={decidedWhen(approval.decidedAt ?? approval.createdAt, group.title)}
                  behind={colors.surface}
                />
              </View>
            ))}
          </Card>
        </Section>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(2), gap: space(6), paddingBottom: space(8) },
  needsHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(1),
  },
  overline: { letterSpacing: 0.6, fontWeight: "700" },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 72,
  },
  text: { flex: 1, gap: 2 },
  caughtUp: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: space(4),
  },
  check: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  tile: {
    width: 48,
    height: 48,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  offline: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
});
