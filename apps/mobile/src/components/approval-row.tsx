import type { ApprovalView, BotSummary } from "@open-bot/api";
import { approvalShortTitle, commandParts, commandSummary } from "@open-bot/domain";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { ApprovalAvatar, ApprovalStatusChip, ApprovalTitle } from "@/components/approval-parts";
import { Text } from "@/components/text";
import { shortenPaths } from "@/lib/approval-text";
import { space, useColors } from "@/theme";

/**
 * The shell command an approval runs, on one line, without the backticks a title quotes it in.
 * Not `subject`: that's only what "always allow" matches, like "git push".
 */
function commandOf(approval: ApprovalView): string {
  const raw = commandParts(approval.detail).command ?? approval.title.replace(/^`|`$/g, "");
  return raw.replace(/\s*\n\s*/g, " ").trim();
}

/** One request in a list: who asked, what for, and when; it opens the request. */
export function ApprovalRow({
  approval,
  bot,
  meta,
  behind,
  short,
}: {
  approval: ApprovalView;
  bot: BotSummary | undefined;
  meta: string;
  /** The card's color, which the avatar's badge cuts into. */
  behind: string;
  /**
   * Home's list: the request in a few words (the amount and the recipient stay in), with no
   * command line under it, so each row reads at a glance.
   */
  short?: boolean;
}) {
  const colors = useColors();
  const pending = approval.status === "pending";
  const command = approval.kind === "command" ? commandOf(approval) : null;
  return (
    <Pressable
      testID="approval"
      onPress={() => router.push(`/approvals/${approval.id}`)}
      android_ripple={{ color: colors.muted }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
      accessibilityRole="button"
      accessibilityHint={pending ? "Opens the request to approve or deny it" : undefined}
    >
      <ApprovalAvatar bot={bot} approval={approval} pending={pending} behind={behind} />
      <View style={styles.text}>
        {short ? (
          <Text variant="label" numberOfLines={2}>
            {shortenPaths(
              approvalShortTitle({ ...approval, previewType: approval.preview?.type ?? null }),
            )}
          </Text>
        ) : command ? (
          // A command leads with what it does in plain words; the command itself follows as code.
          <>
            <Text variant="label" numberOfLines={2}>
              {commandSummary(command)}
            </Text>
            <Text
              variant="mono"
              muted
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{ fontSize: 12, lineHeight: 17 }}
            >
              {command}
            </Text>
          </>
        ) : (
          <ApprovalTitle title={shortenPaths(approval.title)} numberOfLines={2} />
        )}
        <Text variant="small" muted numberOfLines={1}>
          {bot?.name ?? "Former teammate"} · {meta}
        </Text>
      </View>
      {pending ? (
        <ChevronRight size={18} color={colors.attentionInk} />
      ) : (
        <ApprovalStatusChip status={approval.status} size="sm" />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 72,
  },
  text: { flex: 1, gap: 2 },
});
