import type { TimelineItem } from "@open-bot/domain";
import { router } from "expo-router";
import { AlertTriangle, CircleCheck, Hand, Undo2 } from "lucide-react-native";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { FoldableText } from "@/components/chat/foldable-text";
import { Text } from "@/components/text";
import { screenHref } from "@/lib/screens";
import { handBackText, takeoverTitle } from "@/lib/step-text";
import { radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

/** The teammate's plan, each step done, under way or still to do. */
export function PlanCard({ item }: { item: Item<"plan"> }) {
  const colors = useColors();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text variant="overline" muted>
        Plan
      </Text>
      {item.steps.map((step, index) => (
        <View key={index} style={styles.planStep}>
          <View style={styles.planMark}>
            {step.status === "completed" ? (
              <CircleCheck size={16} color={colors.done} />
            ) : step.status === "inProgress" ? (
              <ActivityIndicator size={12} color={colors.foreground} />
            ) : (
              <View style={[styles.planPending, { borderColor: colors.mutedForeground }]} />
            )}
          </View>
          <Text
            variant="small"
            muted={step.status === "completed"}
            style={[
              { flex: 1, fontSize: 14 },
              step.status === "completed" && { textDecorationLine: "line-through" },
            ]}
          >
            {step.step}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A teammate asking you to take over their screen, and what became of it. */
export function TakeoverCard({
  item,
  screenId,
  name,
}: {
  item: Item<"takeover_request">;
  /** The teammate's screen, which has their id. */
  screenId: string;
  name: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          borderColor: mix(colors.attention, colors.surface, 0.4),
          backgroundColor: mix(colors.attention, colors.surface, 0.08),
        },
      ]}
    >
      <View style={styles.row}>
        <Hand size={16} color={colors.attentionInk} />
        <Text variant="label" style={{ flex: 1 }}>
          {takeoverTitle(item.resolution, name)}
        </Text>
      </View>
      <Text variant="small" muted>
        {item.reason}
      </Text>
      {item.resolution === "pending" && (
        <Button
          title="Open the screen"
          onPress={() => router.push(screenHref(screenId, item.takeoverRequestId))}
        />
      )}
    </View>
  );
}

/** A message you sent into a turn: a note with the screen you handed back, or words to steer it. */
export function SentIntoTurn({ item }: { item: Item<"user_message"> }) {
  const colors = useColors();
  if (item.variant === "hand_back")
    return (
      <View
        style={[styles.pill, { backgroundColor: mix(colors.attention, colors.background, 0.12) }]}
      >
        <Undo2 size={14} color={colors.attentionInk} />
        <Text variant="small" style={{ color: colors.attentionInk }}>
          {handBackText(item.text)}
        </Text>
      </View>
    );
  return (
    <View style={styles.steered}>
      <View style={[styles.steeredBubble, { backgroundColor: colors.subtle }]}>
        <FoldableText
          text={item.text}
          style={{ color: colors.foreground, fontSize: 14.5, lineHeight: 22 }}
          background={colors.subtle}
          foreground={colors.foreground}
        />
      </View>
    </View>
  );
}

/** Something that went wrong in the turn. */
export function TurnError({ message }: { message: string }) {
  const colors = useColors();
  return (
    <View
      style={[styles.error, { backgroundColor: mix(colors.destructive, colors.background, 0.08) }]}
    >
      <AlertTriangle size={16} color={colors.destructive} style={{ marginTop: 2 }} />
      <Text variant="small" style={{ color: colors.destructive, flex: 1, fontSize: 14 }}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(2) },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space(4), gap: space(2) },
  planStep: { flexDirection: "row", alignItems: "flex-start", gap: space(2.5) },
  planMark: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  planPending: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, opacity: 0.6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    alignSelf: "flex-start",
    borderRadius: radius.full,
    paddingHorizontal: space(3),
    paddingVertical: space(1),
  },
  steered: { flexDirection: "row", justifyContent: "flex-end" },
  steeredBubble: {
    maxWidth: "85%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2),
  },
  error: {
    flexDirection: "row",
    gap: space(2),
    borderRadius: radius.lg,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
  },
});
