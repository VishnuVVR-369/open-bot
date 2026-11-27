import type { AutomationRunView } from "@open-bot/api";
import { AUTOMATION_RUN_STATUS, formatWhen, isRunActive } from "@open-bot/domain";
import { router } from "expo-router";
import { Check, ChevronRight, CircleSlash, Clock, Loader, X } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { chatHref } from "@/lib/links";
import { space, useColors } from "@/theme";

function RunIcon({ status }: { status: AutomationRunView["status"] }) {
  const colors = useColors();
  if (status === "completed") return <Check size={16} color={colors.done} />;
  if (status === "failed") return <X size={16} color={colors.destructive} />;
  if (status === "interrupted") return <CircleSlash size={16} color={colors.mutedForeground} />;
  if (status === "waiting") return <Clock size={16} color={colors.attentionInk} />;
  if (status === "queued") return <Loader size={16} color={colors.working} />;
  return <ActivityIndicator size="small" color={colors.working} />;
}

/**
 * An automation's recent runs, newest first, each opening its chat at that run, as the web's
 * history links them. A run still going says how it stands; a finished one, what it said.
 */
export function RunHistory({
  runs,
  loading,
  empty,
}: {
  runs: readonly AutomationRunView[] | undefined;
  loading: boolean;
  empty: string;
}) {
  const colors = useColors();
  return (
    <Section title="Recent runs">
      <View testID="automation-runs">
        <Card>
          {loading && !runs ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : !runs?.length ? (
            <View style={styles.empty}>
              <Text variant="small" muted>
                {empty}
              </Text>
            </View>
          ) : (
            runs.map((run, index) => (
              <Pressable
                key={run.id}
                onPress={() => {
                  haptics.tap();
                  router.push(chatHref(run.chatId, run.id));
                }}
                accessibilityRole="button"
                accessibilityHint="Opens the run in its chat"
                android_ripple={{ color: colors.muted }}
                style={[
                  styles.row,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                  },
                ]}
                testID="automation-run"
              >
                <View style={styles.icon}>
                  <RunIcon status={run.status} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                    {formatWhen(run.createdAt)}
                  </Text>
                  <Text
                    variant="small"
                    numberOfLines={2}
                    style={
                      isRunActive(run.status) || !run.preview
                        ? { color: colors.mutedForeground }
                        : undefined
                    }
                  >
                    {isRunActive(run.status) || !run.preview
                      ? AUTOMATION_RUN_STATUS[run.status]
                      : run.preview}
                  </Text>
                </View>
                <ChevronRight size={18} color={colors.mutedForeground} />
              </Pressable>
            ))
          )}
        </Card>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  empty: { paddingHorizontal: space(4), paddingVertical: space(4) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 56,
  },
  icon: { width: 20, alignItems: "center" },
});
