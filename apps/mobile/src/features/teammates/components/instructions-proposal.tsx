import type { PendingProposalView } from "@open-bot/api";
import { instructionsChange } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { Check, Sparkles } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { Button } from "@/components/button";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage, isStateConflict } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { usePendingProposal } from "../hooks";
import { afterConflict } from "../proposals";

type Decision = "accept" | "dismiss";

/** How a suggestion was settled here: by you, or already elsewhere (the server's words). */
type Settled = { id: string; text: string; testID: string };

/**
 * A teammate's suggested instructions, as the change accepting them would make to the instructions
 * as they are now, to accept or dismiss. Once decided it says so until the next suggestion comes.
 * Deciding again the same way is harmless on the server, so a lost answer can be tried again.
 */
export function InstructionsProposalSection({
  teammateId,
  name,
}: {
  teammateId: string;
  name: string;
}) {
  const { data: proposal } = usePendingProposal(teammateId);
  // How it was settled here, kept on screen after the suggestion leaves the server's answer.
  const [settled, setSettled] = useState<Settled | null>(null);
  if (proposal && proposal.id !== settled?.id)
    return <Proposal key={proposal.id} proposal={proposal} name={name} onSettled={setSettled} />;
  if (settled) return <Decided text={settled.text} testID={settled.testID} />;
  return null;
}

function Proposal({
  proposal,
  name,
  onSettled,
}: {
  proposal: PendingProposalView;
  name: string;
  onSettled: (settled: Settled) => void;
}) {
  const colors = useColors();
  const dark = useColorScheme() === "dark";
  const online = useOnline();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { lines, editedSince } = useMemo(
    () => instructionsChange(proposal, proposal.instructionsNow),
    [proposal],
  );

  async function decide(decision: Decision) {
    haptics.tap();
    setBusy(decision);
    setProblem(null);
    // Accepting names the instructions the change was shown against, so if they changed since,
    // or the teammate was archived, it's refused instead of overwriting them.
    const result = await safe(
      decision === "accept"
        ? api.proposals.accept({
            proposalId: proposal.id,
            expectedInstructions: proposal.instructionsNow,
          })
        : api.proposals.dismiss({ proposalId: proposal.id }),
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.home });
    if (decision === "accept")
      void queryClient.invalidateQueries({ queryKey: queryKeys.teammates });
    if (result.error && isStateConflict(result.error)) {
      haptics.error();
      // Read what's waiting now: the same suggestion against changed instructions shows its new
      // diff here to review again; decided elsewhere or replaced, it says so.
      const fresh = await safe(api.proposals.pending({ teammateId: proposal.teammateId }));
      if (!fresh.error)
        queryClient.setQueryData(queryKeys.proposal(proposal.teammateId), fresh.data);
      else
        void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposal.teammateId) });
      setBusy(null);
      if (afterConflict(proposal.id, fresh.error ? undefined : fresh.data) === "review-again")
        return setProblem(errorMessage(result.error));
      return onSettled({
        id: proposal.id,
        text: errorMessage(result.error),
        testID: "proposal-handled",
      });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(proposal.teammateId) });
    setBusy(null);
    if (result.error) {
      haptics.error();
      setProblem(
        errorMessage(
          result.error,
          decision === "accept" ? "Couldn't apply it." : "Couldn't dismiss it.",
        ),
      );
      return;
    }
    haptics.success();
    onSettled(
      decision === "accept"
        ? {
            id: proposal.id,
            text: `${name} has new instructions. They apply from the next message.`,
            testID: "proposal-accepted",
          }
        : {
            id: proposal.id,
            text: "Suggestion dismissed. The instructions stay as they were.",
            testID: "proposal-dismissed",
          },
    );
  }

  return (
    <View
      style={[
        styles.card,
        {
          borderColor: mix(colors.attention, colors.surface, dark ? 0.28 : 0.42),
          backgroundColor: mix(colors.attention, colors.surface, dark ? 0.06 : 0.05),
        },
      ]}
      testID="instructions-proposal"
    >
      <View style={styles.head}>
        <View
          style={[styles.icon, { backgroundColor: mix(colors.attention, colors.surface, 0.22) }]}
        >
          <Sparkles size={18} color={colors.attentionInk} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{`${name} suggests new instructions`}</Text>
          <Text variant="caption" muted>
            {ago(proposal.createdAt)}
          </Text>
        </View>
      </View>
      <Text variant="small">{proposal.reason}</Text>
      {editedSince && (
        <Text variant="small" muted>
          You changed the instructions since. Accepting replaces them with the suggestion.
        </Text>
      )}
      <ScrollView
        nestedScrollEnabled
        style={[styles.diff, { backgroundColor: colors.surface, borderColor: colors.border }]}
        contentContainerStyle={{ paddingVertical: space(2) }}
        testID="proposal-diff"
      >
        {lines.map((line, index) => (
          <View
            key={index}
            style={[
              styles.line,
              line.type === "added" && { backgroundColor: mix(colors.done, colors.surface, 0.12) },
              line.type === "removed" && {
                backgroundColor: mix(colors.destructive, colors.surface, 0.1),
              },
            ]}
            accessibilityLabel={`${line.type === "added" ? "Added" : line.type === "removed" ? "Removed" : "Unchanged"}: ${line.text}`}
          >
            <Text variant="mono" muted style={styles.mark}>
              {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
            </Text>
            <Text
              variant="mono"
              style={[
                { flex: 1 },
                line.type === "added" && { color: colors.done },
                line.type === "removed" && {
                  color: colors.destructive,
                  textDecorationLine: "line-through",
                },
              ]}
            >
              {line.text || " "}
            </Text>
          </View>
        ))}
      </ScrollView>
      {problem && (
        <Text variant="small" style={{ color: colors.destructive }} testID="proposal-problem">
          {problem}
        </Text>
      )}
      <View style={styles.buttons}>
        <Button
          title="Dismiss"
          variant="outline"
          onPress={() => void decide("dismiss")}
          disabled={!online || busy !== null}
          busy={busy === "dismiss"}
          style={{ flex: 1 }}
          testID="proposal-dismiss"
        />
        <Button
          title="Accept"
          onPress={() => void decide("accept")}
          disabled={!online || busy !== null}
          busy={busy === "accept"}
          style={{ flex: 1 }}
          testID="proposal-accept"
        />
      </View>
      {!online && (
        <Text variant="caption" muted>
          You're offline. Decide once you're back.
        </Text>
      )}
    </View>
  );
}

/** How the suggestion was settled, said once it's gone from the server. */
function Decided({ text, testID }: { text: string; testID: string }) {
  const colors = useColors();
  return (
    <View style={[styles.decided, { backgroundColor: colors.subtle }]} testID={testID}>
      <Check size={16} color={colors.mutedForeground} />
      <Text variant="small" muted style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(3) },
  head: { flexDirection: "row", alignItems: "center", gap: space(3) },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  diff: { maxHeight: 280, borderWidth: 1, borderRadius: radius.lg },
  line: { flexDirection: "row", gap: space(2), paddingHorizontal: space(3) },
  mark: { width: 12 },
  buttons: { flexDirection: "row", gap: space(3) },
  decided: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderRadius: radius.lg,
    padding: space(3),
  },
});
