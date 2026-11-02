import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Check, CircleDashed, Fingerprint, MessagesSquare, X } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalIcon } from "@/components/approval-icon";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/button";
import { LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { useDecideApproval, type Decision } from "@/lib/approvals";
import { approvalDetail } from "@/lib/format";
import { useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

const KIND_LABEL = {
  command: "Run a command",
  file_change: "Change files",
  action: "Take an action",
  purchase: "Make a purchase",
  email: "Send an email",
} as const;

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

  if (query.isLoading) return <Loading />;
  if (!query.data) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  const approval = query.data;
  const bot = bots.find((candidate) => candidate.id === approval.botId);
  const pending = approval.status === "pending";

  const onDecide = async (decision: Decision) => {
    setMessage(null);
    const result = await decide(approval, decision);
    if (result.ok) router.back();
    // Decided elsewhere first: the screen now shows how it ended, which says it all.
    else if (!result.settled) setMessage(result.message);
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.who}>
          <BotAvatar
            name={bot?.name ?? "?"}
            color={bot?.color ?? "#888888"}
            emoji={bot?.emoji}
            size="md"
          />
          <View style={{ flex: 1 }}>
            <Text variant="label">{bot?.name ?? "Former teammate"} asks to</Text>
            <Text variant="small" muted>
              {KIND_LABEL[approval.kind]} · {ago(approval.createdAt)}
            </Text>
          </View>
        </View>

        <View
          style={[
            styles.card,
            pending
              ? {
                  borderColor: mix(colors.waiting, colors.surface, 0.35),
                  backgroundColor: mix(colors.waiting, colors.surface, 0.06),
                }
              : { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <View style={styles.title}>
            <ApprovalIcon
              kind={approval.kind}
              size={18}
              color={pending ? colors.waiting : colors.mutedForeground}
            />
            <Text
              variant={approval.kind === "command" ? "mono" : "heading"}
              style={{ flex: 1 }}
              selectable
            >
              {approval.title}
            </Text>
          </View>
          {approval.detail ? (
            <Text variant="small" muted selectable style={{ fontSize: 14, lineHeight: 20 }}>
              {approvalDetail(approval.detail)}
            </Text>
          ) : null}
        </View>

        {!pending && (
          <View style={styles.settled}>
            {approval.status === "approved" ? (
              <Check size={16} color={colors.done} />
            ) : approval.status === "denied" ? (
              <X size={16} color={colors.destructive} />
            ) : (
              <CircleDashed size={16} color={colors.mutedForeground} />
            )}
            <Text muted>
              {approval.status === "expired"
                ? "This expired before it was decided."
                : `You ${approval.status} this.`}
            </Text>
          </View>
        )}
        {message && (
          <Text style={{ color: colors.destructive }} accessibilityRole="alert">
            {message}
          </Text>
        )}
        <Button
          title="Open the chat"
          variant="ghost"
          icon={<MessagesSquare size={16} color={colors.foreground} />}
          onPress={() => router.push(`/chats/${approval.chatId}`)}
          style={{ alignSelf: "flex-start", paddingHorizontal: space(2) }}
        />
      </ScrollView>
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
          <Button
            title="Deny"
            variant="outline"
            busy={deciding === "denied"}
            disabled={deciding !== null}
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
            disabled={deciding !== null}
            onPress={() => void onDecide("approved")}
            style={styles.action}
            testID="approve"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(4) },
  who: { flexDirection: "row", alignItems: "center", gap: space(3) },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  title: { flexDirection: "row", gap: space(2.5), alignItems: "flex-start" },
  settled: { flexDirection: "row", alignItems: "center", gap: space(2) },
  actions: {
    flexDirection: "row",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingTop: space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  action: { flex: 1, minHeight: 48 },
});
