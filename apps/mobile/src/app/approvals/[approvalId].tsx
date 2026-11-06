import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import {
  Check,
  ChevronRight,
  Fingerprint,
  FolderOpen,
  MessagesSquare,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionPreview } from "@/components/action-preview";
import { AlwaysAllowSheet } from "@/components/always-allow-sheet";
import {
  ApprovalAvatar,
  ApprovalStatusChip,
  ApprovalTitle,
  RiskNote,
} from "@/components/approval-parts";
import { botActivity } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { CodeScroll } from "@/components/code-scroll";
import { ListRow } from "@/components/list-row";
import { Card } from "@/components/section";
import { LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { approvalRisk, commandParts } from "@/lib/approval-text";
import { canAlwaysAllow, useDecideApproval, type Decision } from "@/lib/approvals";
import { recently } from "@/lib/day-groups";
import { approvalDetail } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { phoneDayClock } from "@/lib/phone-clock";
import { useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { radius, space, useColors } from "@/theme";

const KIND_LABEL = {
  command: "run a command",
  file_change: "change files",
  action: "take an action",
  purchase: "make a purchase",
  email: "send an email",
  account_write: "change your account",
  account_outward: "act as you",
} as const;

/** A small label over a part of the request. */
function Overline({ children }: { children: string }) {
  return (
    <Text variant="caption" muted style={styles.overline}>
      {children.toUpperCase()}
    </Text>
  );
}

/** What exactly would happen: the command, the diff, or the words of the email or purchase. */
function Detail({ kind, detail }: { kind: string; detail: string }) {
  const colors = useColors();
  if (!detail) return null;
  if (kind === "command") {
    const { reason, command, cwd } = commandParts(detail);
    return (
      <>
        {reason && (
          <Text selectable style={{ color: colors.foreground }}>
            {reason}
          </Text>
        )}
        {command && (
          <View style={{ gap: space(2) }}>
            <Overline>Command</Overline>
            <CodeScroll copyText={command} background={colors.surface} style={styles.code}>
              <Text variant="mono" selectable>
                <Text variant="mono" muted>
                  ${" "}
                </Text>
                {command}
              </Text>
            </CodeScroll>
            {cwd && (
              <View style={styles.cwd}>
                <FolderOpen size={14} color={colors.mutedForeground} />
                <Text variant="caption" muted selectable style={{ flex: 1 }}>
                  in {cwd}
                </Text>
              </View>
            )}
          </View>
        )}
      </>
    );
  }
  if (kind === "file_change")
    return (
      <View style={{ gap: space(2) }}>
        <Overline>Changes</Overline>
        <CodeScroll copyText={detail} background={colors.surface} style={styles.code}>
          <Text variant="mono" selectable>
            {approvalDetail(detail)}
          </Text>
        </CodeScroll>
      </View>
    );
  return (
    <View style={{ gap: space(2) }}>
      <Overline>{kind === "email" ? "Message" : "Details"}</Overline>
      <View style={[styles.prose, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text selectable>{approvalDetail(detail)}</Text>
      </View>
    </View>
  );
}

/** One approval, opened from the list or a notification: what exactly, and your decision. */
export default function ApprovalScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { approvalId } = useLocalSearchParams<{ approvalId: string }>();
  const query = useQuery({
    queryKey: queryKeys.approval(approvalId),
    queryFn: () => api.approvals.get({ approvalId }),
  });
  const { data: bots = [] } = useTeammates();
  const { decide, deciding } = useDecideApproval();
  const [message, setMessage] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const online = useOnline();

  if (query.isLoading) return <Loading />;
  if (!query.data) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  const approval = query.data;
  const bot = bots.find((candidate) => candidate.id === approval.botId);
  const botName = bot?.name ?? "A former teammate";
  const pending = approval.status === "pending";
  const risk = pending ? approvalRisk(approval) : null;
  const allowable = pending && canAlwaysAllow(approval);
  const busy = deciding !== null || !online;

  const onDecide = async (decision: Decision, alwaysAllow: string | null = null) => {
    setMessage(null);
    const result = await decide(approval, decision, alwaysAllow);
    setAllowing(false);
    if (result.ok) {
      if (decision === "approved") haptics.success();
      else haptics.warning();
      router.back();
      return;
    }
    // Decided elsewhere first: the screen now shows how it ended, which says it all.
    if (!result.settled) {
      haptics.error();
      setMessage(result.message);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.who}>
          <ApprovalAvatar
            bot={bot}
            kind={approval.kind}
            pending={pending}
            activity={pending && bot ? botActivity(bot) : "idle"}
            behind={colors.background}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label" numberOfLines={1}>
              {botName} {pending ? "wants to" : "asked to"} {KIND_LABEL[approval.kind]}
            </Text>
            <Text variant="small" muted>
              Asked {recently(approval.createdAt) ?? phoneDayClock(approval.createdAt)}
            </Text>
          </View>
          {!pending && <ApprovalStatusChip status={approval.status} />}
        </View>

        <ApprovalTitle title={approval.title} variant="title" selectable />

        {risk && <RiskNote risk={risk} />}

        {approval.preview ? (
          <View style={{ gap: space(2) }}>
            <Overline>
              {approval.preview.type === "email"
                ? "Message"
                : approval.preview.type === "event"
                  ? "Event"
                  : "In Notion"}
            </Overline>
            <ActionPreview preview={approval.preview} />
          </View>
        ) : (
          <Detail kind={approval.kind} detail={approval.detail} />
        )}

        {!pending && (
          <View style={[styles.settled, { backgroundColor: colors.subtle }]}>
            {approval.status === "approved" ? (
              <Check size={18} color={colors.done} strokeWidth={2.5} />
            ) : approval.status === "denied" ? (
              <X size={18} color={colors.destructive} strokeWidth={2.5} />
            ) : null}
            <View style={{ flex: 1 }}>
              <Text>
                {approval.status === "expired"
                  ? "This expired before it was decided."
                  : `You ${approval.status} this.`}
              </Text>
              {approval.decidedAt && approval.status !== "expired" && (
                <Text variant="caption" muted>
                  {phoneDayClock(approval.decidedAt)}
                </Text>
              )}
            </View>
          </View>
        )}
        {message && (
          <Text style={{ color: colors.destructive }} accessibilityRole="alert">
            {message}
          </Text>
        )}

        <Card>
          <ListRow
            onPress={() => router.push(`/chats/${approval.chatId}`)}
            leading={
              <View style={[styles.tile, { backgroundColor: colors.subtle }]}>
                <MessagesSquare size={20} color={colors.foreground} />
              </View>
            }
            title="Open the chat"
            subtitle={`See what ${bot?.name ?? "they"} ${pending ? "is" : "was"} working on`}
            aside={<ChevronRight size={18} color={colors.mutedForeground} />}
            testID="open-chat"
          />
        </Card>
      </ScrollView>
      {allowable && (
        <AlwaysAllowSheet
          open={allowing}
          onClose={() => setAllowing(false)}
          kind={approval.kind}
          subject={approval.subject ?? ""}
          botName={bot?.name ?? "This teammate"}
          onConfirm={(pattern) => onDecide("approved", pattern)}
        />
      )}
      {pending && (
        <View
          style={[
            styles.actions,
            {
              paddingBottom: insets.bottom + space(3),
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
            },
          ]}
        >
          {!online && (
            <View style={styles.offline}>
              <WifiOff size={14} color={colors.mutedForeground} />
              <Text variant="small" muted>
                You&apos;re offline. Decide when you&apos;re back.
              </Text>
            </View>
          )}
          <View style={styles.decide}>
            <Button
              title="Deny"
              variant="outline"
              icon={<X size={18} color={colors.foreground} />}
              busy={deciding === "denied"}
              disabled={busy}
              onPress={() => void onDecide("denied")}
              style={styles.action}
              testID="deny"
            />
            <Button
              title="Approve"
              icon={
                approval.kind === "purchase" ? (
                  <Fingerprint size={18} color={colors.primaryForeground} />
                ) : (
                  <Check size={18} color={colors.primaryForeground} />
                )
              }
              busy={deciding === "approved"}
              disabled={busy}
              onPress={() => void onDecide("approved")}
              style={styles.action}
              testID="approve"
            />
          </View>
          {allowable && (
            <Button
              title="Always allow…"
              variant="ghost"
              icon={<ShieldCheck size={16} color={colors.foreground} />}
              disabled={busy}
              onPress={() => {
                haptics.tap();
                setAllowing(true);
              }}
              testID="always-allow"
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingTop: space(5), gap: space(5), paddingBottom: space(8) },
  who: { flexDirection: "row", alignItems: "center", gap: space(3.5) },
  overline: { letterSpacing: 0.6, fontWeight: "500", paddingHorizontal: space(1) },
  code: { borderRadius: radius.xl },
  cwd: { flexDirection: "row", alignItems: "center", gap: space(1.5), paddingHorizontal: space(1) },
  prose: { borderWidth: 1, borderRadius: radius.xl, padding: space(4) },
  settled: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  tile: {
    width: 48,
    height: 48,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    gap: space(2),
    paddingHorizontal: space(4),
    paddingTop: space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  decide: { flexDirection: "row", gap: space(3) },
  action: { flex: 1 },
  offline: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space(2) },
});
