import type { ApprovalView } from "@open-bot/api";
import { router } from "expo-router";
import { Check, ChevronRight, CircleDashed, ShieldCheck, WifiOff, X } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { ApprovalIcon } from "@/components/approval-icon";
import { ConnectionNotice } from "@/components/connection-notice";
import { ListRow, Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { useOnline } from "@/lib/network";
import { useApprovalRules, useApprovals, useTeammates } from "@/lib/queries";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

function Status({ approval }: { approval: ApprovalView }) {
  const colors = useColors();
  if (approval.status === "pending")
    return (
      <Text variant="caption" muted>
        {ago(approval.createdAt)}
      </Text>
    );
  const [Icon, color, label] =
    approval.status === "approved"
      ? [Check, colors.done, "Approved"]
      : approval.status === "denied"
        ? [X, colors.destructive, "Denied"]
        : [CircleDashed, colors.mutedForeground, "Expired"];
  return (
    <View style={styles.status}>
      <Icon size={13} color={color} />
      <Text variant="caption" muted>
        {label}
      </Text>
    </View>
  );
}

/** What your teammates asked to do: waiting for you first, then what you decided. */
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
  const sections = useMemo(() => {
    const all = approvals.data ?? [];
    const pending = all.filter((approval) => approval.status === "pending");
    const decided = all.filter((approval) => approval.status !== "pending");
    return [
      ...(pending.length ? [{ title: "Waiting for you", data: pending }] : []),
      ...(decided.length ? [{ title: "Decided", data: decided }] : []),
    ];
  }, [approvals.data]);

  if (approvals.isLoading) return <Loading />;
  if (approvals.error && !approvals.data)
    return <LoadError error={approvals.error} onRetry={() => void approvals.refetch()} />;
  return (
    <SectionList
      sections={sections}
      keyExtractor={(approval) => approval.id}
      ListHeaderComponent={
        <View>
          <ConnectionNotice />
          {!online && sections[0]?.title === "Waiting for you" && (
            <View style={[styles.offline, { backgroundColor: colors.subtle }]}>
              <WifiOff size={14} color={colors.mutedForeground} />
              <Text variant="small" muted>
                You&apos;re offline. Decide when you&apos;re back online.
              </Text>
            </View>
          )}
          {rules.length > 0 && (
            <ListRow
              onPress={() => router.push("/approval-rules")}
              leading={
                <View
                  style={[
                    styles.icon,
                    { backgroundColor: mix(colors.done, colors.background, 0.12) },
                  ]}
                >
                  <ShieldCheck size={20} color={colors.done} />
                </View>
              }
              title="Always allowed"
              subtitle={`${rules.length} ${rules.length === 1 ? "rule" : "rules"} · teammates don't ask about these`}
              aside={<ChevronRight size={18} color={colors.mutedForeground} />}
              testID="approval-rules"
            />
          )}
        </View>
      }
      ItemSeparatorComponent={Separator}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: space(4) }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.foreground]}
          progressBackgroundColor={colors.surface}
        />
      }
      renderSectionHeader={({ section }) => (
        <Text variant="caption" muted style={styles.section}>
          {section.title.toUpperCase()}
        </Text>
      )}
      ListEmptyComponent={
        <Empty
          icon={<ShieldCheck size={28} color={colors.mutedForeground} />}
          title="Nothing to approve"
          body="When a teammate needs your OK, it shows up here and on your lock screen."
        />
      }
      renderItem={({ item: approval }) => {
        const bot = bots.find((candidate) => candidate.id === approval.botId);
        const pending = approval.status === "pending";
        return (
          <ListRow
            testID="approval"
            onPress={() => router.push(`/approvals/${approval.id}`)}
            leading={
              <View
                style={[
                  styles.icon,
                  {
                    backgroundColor: pending
                      ? mix(colors.waiting, colors.background, 0.12)
                      : colors.subtle,
                  },
                ]}
              >
                <ApprovalIcon
                  kind={approval.kind}
                  size={20}
                  color={pending ? colors.waiting : colors.mutedForeground}
                />
              </View>
            }
            title={approval.title}
            subtitle={bot?.name ?? "Former teammate"}
            aside={<Status approval={approval} />}
          />
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  section: {
    letterSpacing: 0.6,
    fontWeight: "500",
    paddingHorizontal: space(4),
    paddingTop: space(5),
    paddingBottom: space(1),
  },
  icon: { width: 48, height: 48, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  status: { flexDirection: "row", alignItems: "center", gap: space(1) },
  offline: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
  },
});
