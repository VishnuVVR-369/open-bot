import type { ApprovalRule } from "@open-bot/api";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, SectionList, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Separator } from "@/components/list-row";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useApprovalRules, useTeammates } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import { space, useColors } from "@/theme";

const KIND = { command: "Commands starting with", file_change: "Changing files", action: "Doing" };

/** What each teammate may do without asking, from "Always allow". Remove one to be asked again. */
export default function ApprovalRules() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const rules = useApprovalRules();
  const { data: bots = [] } = useTeammates();
  const [removing, setRemoving] = useState<string | null>(null);

  const sections = useMemo(() => {
    const byBot = new Map<string, ApprovalRule[]>();
    for (const rule of rules.data ?? [])
      byBot.set(rule.botId, [...(byBot.get(rule.botId) ?? []), rule]);
    return [...byBot].map(([botId, data]) => ({
      bot: bots.find((candidate) => candidate.id === botId),
      data,
    }));
  }, [rules.data, bots]);

  const remove = (rule: ApprovalRule, botName: string) =>
    Alert.alert("Ask about this again?", `${botName} will ask you before doing it next time.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setRemoving(rule.id);
          const result = await safe(api.approvals.removeRule({ ruleId: rule.id }));
          setRemoving(null);
          if (result.error) Alert.alert("Couldn't remove it", errorMessage(result.error));
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvalRules });
        },
      },
    ]);

  if (rules.isLoading) return <Loading />;
  if (rules.error && !rules.data)
    return <LoadError error={rules.error} onRetry={() => void rules.refetch()} />;
  return (
    <SectionList
      sections={sections}
      keyExtractor={(rule) => rule.id}
      stickySectionHeadersEnabled={false}
      ItemSeparatorComponent={Separator}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: space(8) }}
      ListEmptyComponent={
        <Empty
          icon={<ShieldCheck size={28} color={colors.mutedForeground} />}
          title="Nothing allowed yet"
          body="Use “Always allow” on an approval, and the teammate stops asking about things like it."
        />
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.section}>
          <BotAvatar
            name={section.bot?.name ?? "?"}
            color={section.bot?.color ?? "#888888"}
            emoji={section.bot?.emoji}
            size="sm"
          />
          <Text variant="label">{section.bot?.name ?? "Former teammate"}</Text>
        </View>
      )}
      renderItem={({ item: rule, section }) => (
        <View style={styles.row} testID="approval-rule">
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="caption" muted>
              {KIND[rule.kind]}
            </Text>
            {rule.kind !== "file_change" && (
              <Text variant={rule.kind === "command" ? "mono" : "label"} selectable>
                {rule.pattern}
              </Text>
            )}
          </View>
          {removing === rule.id ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Pressable
              onPress={() => remove(rule, section.bot?.name ?? "This teammate")}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Remove"
              testID="remove-rule"
            >
              <X size={18} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: space(4),
    paddingTop: space(5),
    paddingBottom: space(2),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 56,
  },
});
