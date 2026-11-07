import { approvalRisk, approveLabel, type ApprovalItem } from "@open-bot/shared";
import {
  AlertTriangle,
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
import { ActionPreview, previewIcon } from "@/components/action-preview";
import { AlwaysAllowSheet } from "@/components/always-allow-sheet";
import { ApprovalTitle, DetailRows } from "@/components/approval-parts";
import { Button } from "@/components/button";
import { CodeScroll } from "@/components/code-scroll";
import { Text } from "@/components/text";
import { approvalFacts, detailRows, sendsEmail } from "@/lib/approval-text";
import { canAlwaysAllow, useDecideApproval, type Decision } from "@/lib/approvals";
import { approvalDetail } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { useOnline } from "@/lib/network";
import { fonts, radius, space, useColors } from "@/theme";
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
        <Text variant="small" style={{ color: tint, fontWeight: "500" }}>
          {item.decision === "approved"
            ? "Approved"
            : item.decision === "denied"
              ? "Denied"
              : "Expired"}
        </Text>
        <ApprovalTitle
          title={item.title}
          variant="small"
          muted
          numberOfLines={1}
          style={{ flex: 1 }}
        />
      </View>
    );
  }

  const Icon =
    previewIcon(item.preview) ??
    (item.approvalKind === "purchase"
      ? CreditCard
      : sendsEmail({
            kind: item.approvalKind ?? "action",
            title: item.title,
            preview: item.preview,
          })
        ? Mail
        : ShieldAlert);
  const detail = item.detail ? approvalDetail(item.detail) : "";
  const isCode = detail.startsWith("$ ") || item.approvalKind === "file_change";
  const facts = approvalFacts({
    kind: item.approvalKind ?? "action",
    title: item.title,
    detail: item.detail,
    subject: item.subject,
    preview: item.preview,
  });
  const risk = approvalRisk(facts);
  const onDecide = async (decision: Decision, alwaysAllow: string | null = null) => {
    setError(null);
    if (decision === "approved") haptics.press();
    const result = await decide(
      { id: item.approvalId, kind: item.approvalKind ?? "action", chatId },
      decision,
      alwaysAllow,
    );
    setAllowing(false);
    if (result.ok) {
      if (result.status === "approved") haptics.success();
      else haptics.warning();
      animateLayout();
    } else if (!result.settled) {
      haptics.error();
      setError(result.message);
    }
  };
  const rule = { kind: item.approvalKind, subject: item.subject, askEveryTime: item.askEveryTime };
  const busy = deciding !== null || !online;
  return (
    <View
      style={[
        styles.card,
        {
          borderColor: mix(colors.attention, colors.surface, 0.55),
          backgroundColor: mix(colors.attention, colors.surface, 0.08),
        },
      ]}
      testID="approval-card"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.head}>
        <View
          style={[styles.icon, { backgroundColor: mix(colors.attention, colors.surface, 0.24) }]}
        >
          <Icon size={17} color={colors.attentionInk} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="small" style={{ color: colors.attentionInk, fontWeight: "600" }}>
            {botName} needs your approval
          </Text>
          <ApprovalTitle title={item.title} style={{ fontSize: 16, lineHeight: 22 }} />
        </View>
      </View>
      {item.preview ? (
        <ActionPreview preview={item.preview} compact />
      ) : detail ? (
        isCode ? (
          <CodeScroll background={colors.surface}>
            <Text
              selectable
              numberOfLines={12}
              style={{
                fontFamily: fonts.mono,
                fontSize: 12.5,
                lineHeight: 18,
                color: colors.foreground,
              }}
            >
              {detail}
            </Text>
          </CodeScroll>
        ) : detailRows(detail) ? (
          <DetailRows detail={detail} />
        ) : (
          <Text
            variant="small"
            muted
            numberOfLines={12}
            selectable
            style={{ fontSize: 14, lineHeight: 20 }}
          >
            {detail}
          </Text>
        )
      ) : null}
      {risk && (
        <View
          style={[
            styles.risk,
            {
              backgroundColor:
                risk.tone === "destructive"
                  ? mix(colors.destructive, colors.surface, 0.1)
                  : mix(colors.attention, colors.surface, 0.18),
            },
          ]}
        >
          <AlertTriangle
            size={13}
            color={risk.tone === "destructive" ? colors.destructive : colors.attentionInk}
          />
          <Text
            variant="caption"
            style={{
              fontWeight: "600",
              color: risk.tone === "destructive" ? colors.destructive : colors.attentionInk,
            }}
          >
            {risk.label}
          </Text>
        </View>
      )}
      {error && (
        <Text variant="small" style={{ color: colors.destructive }}>
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button
          title="Deny"
          variant="outline"
          busy={deciding === "denied"}
          disabled={busy}
          onPress={() => void onDecide("denied")}
          style={styles.action}
          testID="deny"
        />
        <Button
          title={approveLabel(facts)}
          icon={<Check size={17} color={colors.primaryForeground} />}
          busy={deciding === "approved"}
          disabled={busy}
          onPress={() => void onDecide("approved")}
          style={styles.action}
          testID="approve"
        />
      </View>
      {canAlwaysAllow(rule) && (
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
        <View style={styles.offline}>
          <WifiOff size={13} color={colors.mutedForeground} />
          <Text variant="caption" muted>
            You&apos;re offline. Decide when you&apos;re back online.
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
  settled: { flexDirection: "row", alignItems: "center", gap: space(1.5), minHeight: 28 },
  card: { borderWidth: 1, borderRadius: radius.xl + 2, padding: space(4), gap: space(3) },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space(3) },
  icon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  risk: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    alignSelf: "flex-start",
    borderRadius: radius.full,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
  },
  actions: { flexDirection: "row", gap: space(2.5) },
  action: { flex: 1 },
  allow: { minHeight: 44, marginTop: -space(1), marginBottom: -space(2) },
  offline: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
});
