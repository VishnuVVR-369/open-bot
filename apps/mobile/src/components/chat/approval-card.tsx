import { approvalDetail } from "@/lib/format";
import type { ApprovalItem } from "@open-bot/shared";
import {
  Check,
  CircleDashed,
  CreditCard,
  Mail,
  ShieldAlert,
  WifiOff,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { AlwaysAllowSheet } from "@/components/always-allow-sheet";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { canAlwaysAllow, useDecideApproval, type Decision } from "@/lib/approvals";
import { useOnline } from "@/lib/network";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** An approval in the chat: decide it here, or see how it was decided. */
export function ApprovalCard({
  item,
  chatId,
  botName,
}: {
  item: ApprovalItem;
  chatId: string;
  botName: string;
}) {
  const colors = useColors();
  const { decide, deciding } = useDecideApproval();
  const [error, setError] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const online = useOnline();

  if (item.decision !== "pending") {
    const Icon =
      item.decision === "approved" ? Check : item.decision === "denied" ? X : CircleDashed;
    const tint =
      item.decision === "approved"
        ? colors.done
        : item.decision === "denied"
          ? colors.destructive
          : colors.mutedForeground;
    return (
      <View style={styles.settled}>
        <Icon size={14} color={tint} />
        <Text variant="small" muted numberOfLines={1} style={{ flex: 1 }}>
          {item.decision === "approved"
            ? "You approved"
            : item.decision === "denied"
              ? "You denied"
              : "Expired"}
          : {item.title}
        </Text>
      </View>
    );
  }

  const Icon =
    item.approvalKind === "purchase"
      ? CreditCard
      : item.approvalKind === "email"
        ? Mail
        : ShieldAlert;
  const onDecide = async (decision: Decision, alwaysAllow: string | null = null) => {
    setError(null);
    const result = await decide(
      { id: item.approvalId, kind: item.approvalKind ?? "action", chatId },
      decision,
      alwaysAllow,
    );
    setAllowing(false);
    if (!result.ok && !result.settled) setError(result.message);
  };
  const rule = { kind: item.approvalKind, subject: item.subject, askEveryTime: item.askEveryTime };
  const busy = deciding !== null || !online;
  return (
    <View
      style={[
        styles.card,
        {
          borderColor: mix(colors.waiting, colors.surface, 0.35),
          backgroundColor: mix(colors.waiting, colors.surface, 0.06),
        },
      ]}
      testID="approval-card"
    >
      <View style={styles.head}>
        <Icon size={16} color={colors.waiting} style={{ marginTop: 3 }} />
        <View style={{ flex: 1, gap: space(1) }}>
          <Text variant="label">Approve: {item.title}</Text>
          {item.detail ? (
            <Text variant="small" muted numberOfLines={12} selectable>
              {approvalDetail(item.detail)}
            </Text>
          ) : null}
        </View>
      </View>
      {error && (
        <Text variant="small" style={{ color: colors.destructive, marginLeft: space(6) }}>
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button
          title="Approve"
          icon={<Check size={16} color={colors.primaryForeground} />}
          busy={deciding === "approved"}
          disabled={busy}
          onPress={() => void onDecide("approved")}
          style={styles.action}
          testID="approve"
        />
        <Button
          title="Deny"
          variant="outline"
          busy={deciding === "denied"}
          disabled={busy}
          onPress={() => void onDecide("denied")}
          style={styles.action}
          testID="deny"
        />
      </View>
      {canAlwaysAllow(rule) && (
        // Its own line, lined up with the buttons, so it fits however wide the screen is.
        <Button
          title="Always allow…"
          variant="ghost"
          disabled={busy}
          onPress={() => setAllowing(true)}
          style={styles.allow}
          testID="always-allow"
        />
      )}
      {!online && (
        <View style={[styles.offline, { marginLeft: space(6) }]}>
          <WifiOff size={13} color={colors.mutedForeground} />
          <Text variant="caption" muted>
            You&apos;re offline
          </Text>
        </View>
      )}
      {canAlwaysAllow(rule) && (
        <AlwaysAllowSheet
          open={allowing}
          onClose={() => setAllowing(false)}
          kind={rule.kind}
          subject={item.subject ?? ""}
          botName={botName}
          onConfirm={(pattern) => onDecide("approved", pattern)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  settled: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: 24 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  head: { flexDirection: "row", gap: space(2.5) },
  actions: { flexDirection: "row", gap: space(2), marginLeft: space(6) },
  action: { minHeight: 38, paddingHorizontal: space(3.5) },
  allow: {
    alignSelf: "flex-start",
    minHeight: 32,
    marginLeft: space(6),
    marginVertical: -space(1.5),
    paddingHorizontal: 0,
  },
  offline: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
});
