import type { ApprovalView, TeammateSummary, Home } from "@open-bot/api";
import { router } from "expo-router";
import { Hand, Monitor, ShieldAlert, Sparkles } from "lucide-react-native";
import { View, StyleSheet } from "react-native";
import { TeammateAvatar, needsYouText } from "@/features/teammates/components/teammate-avatar";
import { ApprovalRow } from "@/features/approvals/components/approval-row";
import { Separator } from "@/components/list-row";
import { Section } from "@/components/section";
import { Text } from "@/components/text";
import { screenHref } from "@/features/computer/screens";
import { ago } from "@/lib/time";
import { space, useColors, radius } from "@/theme";
import { mix } from "@/theme/mix";
import { Callout } from "./callout";
import { TakeoverLater } from "./takeover-later";
import { shared } from "./styles";

/**
 * What needs you, each thing on its own: every approval as a row (strongest, as you can decide it
 * right here), then takeovers, then suggestions you review on the computer, which aren't counted.
 */
export function NeedsYou({
  home,
  approvals,
  teammates,
  computerOffline,
}: {
  home: Home;
  /** Pending approvals, or null until they've loaded (Home's count stands in until then). */
  approvals: ApprovalView[] | null;
  teammates: TeammateSummary[];
  computerOffline: boolean;
}) {
  const colors = useColors();
  const proposals = home.proposals.flatMap((proposal) => {
    const teammate = teammates.find((entry) => entry.id === proposal.teammateId);
    return teammate ? [{ ...proposal, teammate }] : [];
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
                  teammate={teammates.find((teammate) => teammate.id === approval.teammateId)}
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
                  shared.mark,
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
          const teammate = teammates.find((entry) => entry.id === request.teammateId);
          const open = () => router.push(screenHref(request.screenId, request.id));
          // The screen can't be driven while the computer is away: a lighter card, after what
          // you can decide now, that only says when you can.
          return computerOffline ? (
            <TakeoverLater key={request.id} request={request} teammate={teammate} onOpen={open} />
          ) : (
            <Callout
              key={request.id}
              leading={
                teammate ? (
                  <TeammateAvatar {...teammate} size="md" />
                ) : (
                  <Hand size={20} color={colors.attentionInk} />
                )
              }
              onPress={open}
              action="Open"
              testID="takeover-request"
            >
              <Text variant="label">
                {request.teammateName} {needsYouText("takeover").toLowerCase()}
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
            accessibilityLabel={`Suggestion: ${proposal.teammate.name} suggests new instructions. Review them in open-bot on your computer.`}
            testID="proposal"
          >
            <View style={[styles.suggestionIcon, { backgroundColor: colors.subtle }]}>
              <Sparkles size={16} color={colors.foreground} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text variant="label" numberOfLines={1} style={{ fontSize: 15 }}>
                {proposal.teammate.name} suggests new instructions
              </Text>
              <View style={shared.noteTag}>
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

const styles = StyleSheet.create({
  calloutBody: { fontSize: 14, lineHeight: 19 },
  approvals: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
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
});
